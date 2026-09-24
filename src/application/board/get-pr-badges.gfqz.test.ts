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
// いた。この修正で statusGate.acquire() に優先度 ('high'=前景 / 'low'=背景継続) を
// 渡せるようにし (concurrency.ts)、getPrBadges() は自分の overallTimeoutMs が
// 発火済みかどうか (timedOut) で 'low'/'high' を選ぶ (get-pr-badges.ts)。このファイルは
// 実際の本番シナリオ (gates を共有した2つの getPrBadges 呼び出し) を end-to-end
// で再現する。Semaphore 自体のスケジューリング契約は concurrency.gfqz.test.ts、
// resolvePrStatus の配線は resolve-pr-status.gfqz.test.ts を参照。

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
  delayMs: number,
): CommentReader {
  const urlByTicketId = new Map(tickets.map((ticket, index) => [ticket.id, urls[index]]));
  return {
    listComments: vi.fn(async (_rootPath: string, issueId: string) => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return [
        {
          id: 'c1',
          issueId,
          author: 'agent',
          text: `PR: ${urlByTicketId.get(issueId)}`,
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
        },
      ];
    }),
  };
}

describe(
  'getPrBadges: a later foreground request is not stuck behind a background-continuation ' +
    'backlog on shared gates (bdboard-gfqz)',
  () => {
    it(
      'launches the foreground gh fetch before the queued background-continuation gh fetches ' +
        'when both share the same statusGate',
      async () => {
        const callOrder: string[] = [];
        const gates = createPrBadgeGates({ statusFetchConcurrency: 1 });
        const updatedAt = new Date('2026-06-01T12:00:00.000Z');

        // --- 大きな (フィルタなしの) リクエスト: 応答をすぐタイムアウトさせ、残り2件の
        // ステータス取得はバックグラウンド継続として走らせる。 ---
        const bgCache = createFakeBoardCache();
        const bgProject = project('proj-bg', '/projects/bg');
        const bgUrls = Array.from(
          { length: 3 },
          (_, index) => `https://github.com/xiaotiantakumi/bdboard/pull/${800 + index}`,
        );
        bgCache.putProject({
          project: bgProject,
          tickets: Array.from({ length: 3 }, (_, index) =>
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
        // コメント解決を overallTimeoutMs (5ms) より遅くする (30ms) —— どのチケットも
        // タイムアウト発火前には resolvePrStatus に到達しない (=timedOut が立って
        // から初めて statusGate.acquire('low') が呼ばれる) ことを保証するため。
        const bgCommentReader = commentReaderForUrls(bgTickets, bgUrls, 30);
        const bgStatusReader: PrStatusReader = {
          getPrStatus: vi.fn(async (url: string) => {
            callOrder.push(url);
            // 最初に permit を握った1件が居座り続けるくらい長くかかる gh 呼び出しを
            // 模す。この間に foreground リクエストを差し込む。
            await new Promise((resolve) => setTimeout(resolve, 80));
            return { status: { state: 'open', checkStatus: 'pass' } } as const;
          }),
        };
        const bgStatusCache = new PrBadgeStatusCache();

        const bgCall = getPrBadges(bgCache, bgCommentReader, bgStatusReader, {
          statusCache: bgStatusCache,
          gates,
          overallTimeoutMs: 5,
        });

        const badges = await bgCall;
        // 応答時点ではまだ1件も解決していない (コメント解決30ms、予算5msなので)。
        expect(badges.every((badge) => badge.status === null)).toBe(true);

        // 背景継続が3件とも statusGate.acquire() を呼び終える (1件が permit を握り、
        // 2件が待ち行列に並ぶ) まで待つ。
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
        const fgCommentReader = commentReaderForUrls(fgTickets, [fgUrl], 0);
        const fgStatusReader: PrStatusReader = {
          getPrStatus: vi.fn(async (url: string) => {
            callOrder.push(url);
            return { status: { state: 'open', checkStatus: 'pass' } } as const;
          }),
        };
        const fgStatusCache = new PrBadgeStatusCache();

        // overallTimeoutMs を渡さない (通常の前景リクエスト): getPrBadges() 内部の
        // timedOut は false のまま固定されるので、この呼び出し由来の
        // statusGate.acquire() は必ず 'high' で呼ばれる。
        await getPrBadges(fgCache, fgCommentReader, fgStatusReader, {
          statusCache: fgStatusCache,
          gates,
        });

        // 背景継続も最終的には完了する (飢えない)。
        await vi.waitFor(
          () => {
            expect(bgStatusReader.getPrStatus).toHaveBeenCalledTimes(3);
          },
          { timeout: 2000, interval: 5 },
        );

        // 本題: 最初に permit を握った背景の1件目の次に、背景の残り2件 (待ち行列に
        // 並んでいた分) より前に、前景リクエストの gh 起動が通っている。
        expect(callOrder).toEqual([bgUrls[0], fgUrl, bgUrls[1], bgUrls[2]]);
      },
      10_000,
    );
  },
);
