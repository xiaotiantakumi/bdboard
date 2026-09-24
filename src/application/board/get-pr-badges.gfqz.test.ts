import { describe, expect, it, vi } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../ports/board-cache-fakes.js';
import type { CommentReader } from '../ports/comment-reader.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';
import { createPrBadgeGates, getPrBadges, PrBadgeStatusCache } from './get-pr-badges.js';

// bdboard-gfqz: /api/pr-links の statusGate は全リクエスト共有の FIFO Semaphore
// だったため、大きな (フィルタなしの) リクエストの overallTimeoutMs 超過後の
// バックグラウンド継続 (bdboard-ksed) が大量に gh 起動を待ち行列に積むと、後から
// 来た小さな (プロジェクト絞り込みの) リクエストの gh 起動がその後ろに並ばされて
// いた。
//
// round 1 の修正 (優先度を acquire() を呼んだ瞬間=待ち行列に並んだ瞬間に固定する
// 設計) は opus レビューで実質的に効かないことが分かった: 本番の典型的な状況
// (comment/status キャッシュが温まっている) では、あるリクエストのほぼ全チケットが
// 自分の overallTimeoutMs (本物の setTimeout) が発火するよりずっと前、マイクロ
// タスクのバーストの中で resolvePrStatus/statusGate.acquire() に到達してしまう
// (Node はタイマーフェーズに進む前に保留中のマイクロタスクを全部消化するため)。
// つまり「並んだ瞬間」だけで優先度を決めると、並んだ時点ではほぼ全員が 'high' の
// まま並び、その後いくらタイムアウトが発火しても並び順が変わらない。
//
// このファイルは、その「温まったキャッシュ」シナリオを直接再現する: 両リクエスト
// ともコメント解決は即座 (遅延なし)、statusCache は本番同様 (pr-links-routes.ts の
// prBadgeStatusCache) 両リクエストで共有する。修正後の Semaphore は permit を渡す
// 瞬間に都度優先度を再評価するので、背景リクエストのチケットが「並んだ時点では
// high だったが、待っている間に自分の overallTimeoutMs が発火して low に降格した」
// 状態を正しく検出し、後から並んだ本当にまだ応答を待っている前景リクエストの
// チケットを先に通す。Semaphore 自体のスケジューリング契約は
// concurrency.gfqz.test.ts、resolvePrStatus の配線は resolve-pr-status.gfqz.test.ts
// を参照。

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function createFakeBoardCache(): BoardCache & { readonly entries: Map<string, CachedProject> } {
  const entries = new Map<string, CachedProject>();

  return {
    entries,
    getProject(projectId: string): CachedProject | undefined {
      return entries.get(projectId);
    },
    putProject(entry: CachedProject): void {
      entries.set(entry.project.id, entry);
    },
    listProjects(): readonly CachedProject[] {
      return [...entries.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
    },
    deleteProject(projectId: string): void {
      entries.delete(projectId);
    },
    clear(): void {
      entries.clear();
    },
    getTranscriptOffset(): number | undefined {
      return undefined;
    },
    setTranscriptOffset(): void {},
    addSessionUsage(): void {},
    getSessionUsage(): readonly never[] {
      return [];
    },
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close(): void {},
  };
}

function commentReaderForUrls(
  tickets: readonly { readonly id: string }[],
  urls: readonly string[],
): CommentReader {
  const urlByTicketId = new Map(tickets.map((ticket, index) => [ticket.id, urls[index]]));
  return {
    // 遅延なし: 温まったキャッシュ相当 (マイクロタスクだけで解決する) を模す。
    listComments: vi.fn(async (_rootPath: string, issueId: string) => [
      {
        id: 'c1',
        issueId,
        author: 'agent',
        text: `PR: ${urlByTicketId.get(issueId)}`,
        createdAt: new Date('2026-06-01T12:00:00.000Z'),
      },
    ]),
  };
}

describe(
  'getPrBadges: a later foreground request is not stuck behind a background-continuation ' +
    'backlog on a shared statusGate, even with a warm cache where every ticket enqueues ' +
    'before any timeout fires (bdboard-gfqz)',
  () => {
    it(
      'launches the foreground gh fetch before the queued background-continuation gh fetches, ' +
        'sharing one statusCache and one statusGate across both requests, with instant ' +
        '(warm-cache-style) comment resolution',
      async () => {
        const callOrder: string[] = [];
        const gates = createPrBadgeGates({ statusFetchConcurrency: 1 });
        // 本番の pr-links-routes.ts と同様、リクエストをまたいで1つの statusCache を
        // 共有する (round 1 のテストは bg/fg で別々の statusCache を使っていたため、
        // このレビュー指摘 (F4) の再現にならなかった)。
        const sharedStatusCache = new PrBadgeStatusCache();
        const updatedAt = new Date('2026-06-01T12:00:00.000Z');

        // --- 大きな (フィルタなしの) リクエスト ---
        const bgCache = createFakeBoardCache();
        const bgProject = project('proj-bg', '/projects/bg');
        const bgUrls = Array.from(
          { length: 5 },
          (_, index) => `https://github.com/xiaotiantakumi/bdboard/pull/${800 + index}`,
        );
        bgCache.putProject({
          project: bgProject,
          tickets: Array.from({ length: 5 }, (_, index) =>
            makeTicket({
              id: `bdboard-gfqz-bg-${index}`,
              projectId: bgProject.id,
              commentCount: 1,
              updatedAt,
            }),
          ),
          fingerprint: 'fp-bg',
          fetchedAt: updatedAt,
        });
        const bgTickets = bgCache.listProjects()[0]!.tickets;
        const bgCommentReader = commentReaderForUrls(bgTickets, bgUrls);
        const bgStatusReader: PrStatusReader = {
          getPrStatus: vi.fn(async (url: string) => {
            callOrder.push(url);
            if (url === bgUrls[0]) {
              // 最初に permit を握った1件だけ、foreground リクエストを差し込む余地が
              // 出来るくらい長くかかる gh 呼び出しを模す。
              await new Promise((resolve) => setTimeout(resolve, 80));
            }
            return { status: { state: 'open', checkStatus: 'pass' } } as const;
          }),
        };

        const bgCall = getPrBadges(bgCache, bgCommentReader, bgStatusReader, {
          statusCache: sharedStatusCache,
          gates,
          overallTimeoutMs: 5,
        });

        const badges = await bgCall;
        // 応答時点ではまだ1件も解決していない (statusFetchConcurrency=1 なので1件目の
        // 80ms 待ちの間に5msの応答タイムアウトが先に来る)。
        expect(badges.every((badge) => badge.status === null)).toBe(true);

        // 5件全部が statusGate.acquire() を呼び終える (1件が permit を握り、4件が
        // 待ち行列に並ぶ) まで待つ —— コメント解決が即座なので、これは
        // bgCall が解決するより先に (同じマイクロタスクのバーストの中で) 起きている
        // はずだが、念のため待ち行列の形成を明示的に確認する。
        await vi.waitFor(
          () => {
            expect(bgStatusReader.getPrStatus).toHaveBeenCalledTimes(1);
          },
          { timeout: 2000, interval: 5 },
        );

        // --- 後から来た小さな (プロジェクト絞り込みの) リクエスト ---
        const fgCache = createFakeBoardCache();
        const fgProject = project('proj-fg', '/projects/fg');
        const fgUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/900';
        fgCache.putProject({
          project: fgProject,
          tickets: [
            makeTicket({
              id: 'bdboard-gfqz-fg-0',
              projectId: fgProject.id,
              commentCount: 1,
              updatedAt,
            }),
          ],
          fingerprint: 'fp-fg',
          fetchedAt: updatedAt,
        });
        const fgTickets = fgCache.listProjects()[0]!.tickets;
        const fgCommentReader = commentReaderForUrls(fgTickets, [fgUrl]);
        const fgStatusReader: PrStatusReader = {
          getPrStatus: vi.fn(async (url: string) => {
            callOrder.push(url);
            return { status: { state: 'open', checkStatus: 'pass' } } as const;
          }),
        };

        // overallTimeoutMs を渡さない (通常の前景リクエスト): この呼び出し由来の
        // statusGate.acquire() に渡される優先度プロバイダは常に 'high' を返す。
        await getPrBadges(fgCache, fgCommentReader, fgStatusReader, {
          statusCache: sharedStatusCache,
          gates,
        });

        // 背景継続も最終的には完了する (飢えない)。
        await vi.waitFor(
          () => {
            expect(bgStatusReader.getPrStatus).toHaveBeenCalledTimes(5);
          },
          { timeout: 2000, interval: 5 },
        );

        // 本題: 背景リクエストの5件は、並んだ瞬間 (bgCall の overallTimeoutMs=5ms が
        // 発火するより前) は全部 'high' として並んでいた。修正が正しく効いていれば、
        // 最初に permit を握った1件目の次に、待ち行列に残っていた背景の4件より前に、
        // 後から並んだ前景リクエストの gh 起動が通る (permit を渡す瞬間に
        // timedOut===true と再評価されて 'low' に降格しているため)。
        expect(callOrder).toEqual([bgUrls[0], fgUrl, bgUrls[1], bgUrls[2], bgUrls[3], bgUrls[4]]);
      },
      10_000,
    );
  },
);
