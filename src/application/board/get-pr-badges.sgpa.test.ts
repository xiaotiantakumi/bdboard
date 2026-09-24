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
import { createPrBadgeGates, getPrBadges, PrBadgeCommentCache } from './get-pr-badges.js';

// bdboard-sgpa / bdboard-3znc 用のテストをここへ切り出した (get-pr-badges.test.ts の
// ESLint max-lines 上限 (1530行、eslint.config.mjs の MAX_LINES_ALLOWLIST) 超過対応。
// hygiene.aggregate.test.ts / hygiene.shared.test.ts の分割方針と同じ命名規約
// (<basename>.<concern>.test.ts) に倣う。フィクスチャ用ヘルパーは get-pr-badges.test.ts
// 側にも同名のものがあるが、テストファイル間の共有ヘルパーモジュールを新設するリスクより
// 単純な複製の方がこの規模では安全と判断した (このファイルでしか使わない4つの小さい
// 関数のみ)。

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

const PR_URL = 'https://github.com/xiaotiantakumi/bdboard/pull/99';

function commentReaderForUrls(
  tickets: readonly { readonly id: string }[],
  urls: readonly string[],
): CommentReader {
  const urlByTicketId = new Map(tickets.map((ticket, index) => [ticket.id, urls[index]]));
  return {
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

describe('getPrBadges: shared commentGate/statusGate across overlapping requests (bdboard-sgpa)', () => {
  it('bounds total concurrent bd comment fetches across two overlapping getPrBadges calls to the shared commentGate limit', async () => {
    // 修正前は getPrBadges() が呼び出しごとに新しい Semaphore(COMMENT_FETCH_CONCURRENCY)
    // を作っていたため、2つの重なった呼び出し (それぞれ6件、計12件) が同時に走ると
    // 合計で最大6件まで bd を同時起動できてしまっていた (意図した上限は3件)。
    // createPrBadgeGates() で1組だけ作って両方の呼び出しに渡すと、合計でも3件までに
    // 抑えられることを見る。
    const cacheA = createFakeBoardCache();
    const cacheB = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const b = project('proj-b', '/projects/b');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');

    cacheA.putProject({
      project: a,
      tickets: Array.from({ length: 6 }, (_, index) =>
        makeTicket({ id: `bdboard-ov-a-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
      ),
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });
    cacheB.putProject({
      project: b,
      tickets: Array.from({ length: 6 }, (_, index) =>
        makeTicket({ id: `bdboard-ov-b-${index}`, projectId: b.id, commentCount: 1, updatedAt }),
      ),
      fingerprint: 'fp-b',
      fetchedAt: updatedAt,
    });

    let activeCount = 0;
    const maxObserved = { value: 0 };
    function makeReader(): CommentReader {
      return {
        listComments: vi.fn(async () => {
          activeCount += 1;
          maxObserved.value = Math.max(maxObserved.value, activeCount);
          await new Promise((resolve) => setTimeout(resolve, 40));
          activeCount -= 1;
          return [];
        }),
      };
    }

    const readerA = makeReader();
    const readerB = makeReader();
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const),
    };

    const gates = createPrBadgeGates();

    await Promise.all([
      getPrBadges(cacheA, readerA, prStatusReader, { gates }),
      getPrBadges(cacheB, readerB, prStatusReader, { gates }),
    ]);

    expect(maxObserved.value).toBeLessThanOrEqual(3);
    expect(maxObserved.value).toBeGreaterThan(1);
  });

  it('bounds total concurrent gh status launches across two overlapping getPrBadges calls to the shared statusGate limit', async () => {
    const fullCache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const urls = Array.from(
      { length: 8 },
      (_, index) => `https://github.com/xiaotiantakumi/bdboard/pull/${950 + index}`,
    );
    fullCache.putProject({
      project: a,
      tickets: Array.from({ length: 8 }, (_, index) =>
        makeTicket({ id: `bdboard-sg-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
      ),
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });
    const tickets = fullCache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    let activeCount = 0;
    const maxObserved = { value: 0 };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => {
        activeCount += 1;
        maxObserved.value = Math.max(maxObserved.value, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 40));
        activeCount -= 1;
        return { status: { state: 'open', checkStatus: 'pass' } } as const;
      }),
    };

    // statusFetchConcurrency=4 の shared gate を作り、8件を4件ずつ2つの重なった
    // 呼び出しへ振り分ける。共有していれば合計でも同時に gh を起動するのは4件まで
    // (共有していなければ、修正前のバグと同じ理屈で最大8件まで同時起動しうる)。
    const gates = createPrBadgeGates({ statusFetchConcurrency: 4 });
    const half = tickets.length / 2;
    const cacheFirst = createFakeBoardCache();
    const cacheSecond = createFakeBoardCache();
    cacheFirst.putProject({
      project: a,
      tickets: tickets.slice(0, half),
      fingerprint: 'fp-a1',
      fetchedAt: updatedAt,
    });
    cacheSecond.putProject({
      project: a,
      tickets: tickets.slice(half),
      fingerprint: 'fp-a2',
      fetchedAt: updatedAt,
    });

    await Promise.all([
      getPrBadges(cacheFirst, commentReader, prStatusReader, { gates }),
      getPrBadges(cacheSecond, commentReader, prStatusReader, { gates }),
    ]);

    expect(maxObserved.value).toBeLessThanOrEqual(4);
    expect(maxObserved.value).toBeGreaterThan(1);
  });

  it('shares an in-flight comment fetch for the same ticket across two overlapping getPrBadges calls, launching bd only once (in-flight dedup)', async () => {
    // フィラーの3チケットで commentGate (concurrency=3) の枠を全部埋め、本題の
    // チケット (bdboard-dup) の解決に競合が起きやすい状況を作る。commentCache と
    // gates を両方の呼び出しで共有すれば、同じチケットに対する bd 起動は1回だけで
    // 済むはず —— 共有していなければ (修正前のバグ) 重なった2つの呼び出しがそれぞれ
    // 独立に bd を起動してしまう。
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [
        ...Array.from({ length: 3 }, (_, index) =>
          makeTicket({ id: `bdboard-filler-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
        ),
        makeTicket({ id: 'bdboard-dup', projectId: a.id, commentCount: 1, updatedAt }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });

    let dupCalls = 0;
    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath, issueId) => {
        if (issueId === 'bdboard-dup') {
          dupCalls += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
        return [
          {
            id: 'c1',
            issueId,
            author: 'agent',
            text: `PR: ${PR_URL}`,
            createdAt: updatedAt,
          },
        ];
      }),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const),
    };

    const commentCache = new PrBadgeCommentCache();
    const gates = createPrBadgeGates();

    const [badgesA, badgesB] = await Promise.all([
      getPrBadges(cache, commentReader, prStatusReader, { commentCache, gates }),
      getPrBadges(cache, commentReader, prStatusReader, { commentCache, gates }),
    ]);

    expect(dupCalls).toBe(1);
    const dupBadgeA = badgesA.find((badge) => badge.ticketId === 'bdboard-dup');
    const dupBadgeB = badgesB.find((badge) => badge.ticketId === 'bdboard-dup');
    expect(dupBadgeA?.url).toBe(PR_URL);
    expect(dupBadgeB?.url).toBe(PR_URL);
  });
});

describe('getPrBadges: unfetched tickets are reported explicitly instead of omitted (bdboard-3znc)', () => {
  it('reports tickets whose comment-scan has not resolved by the time budget as url:null (unfetched), not omitted', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');

    const fastId = 'bdboard-3znc-fast';
    const hangingIds = Array.from({ length: 5 }, (_, index) => `bdboard-3znc-hang-${index}`);

    cache.putProject({
      project: a,
      tickets: [fastId, ...hangingIds].map((id) =>
        makeTicket({ id, projectId: a.id, commentCount: 1, updatedAt }),
      ),
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });

    let releaseHanging: (() => void) | undefined;
    const hangingGate = new Promise<void>((resolve) => {
      releaseHanging = resolve;
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath, issueId) => {
        if (issueId === fastId) {
          return [
            { id: 'c1', issueId, author: 'agent', text: `PR: ${PR_URL}`, createdAt: updatedAt },
          ];
        }
        // 全体タイムアウト (30ms) より確実に長く未解決のままにする —— 走査が
        // 「始まってすらいない」場合も「始まったが終わっていない」場合も、どちらも
        // url:null のまま応答に残ること (省略されないこと) を見るのが本題なので、
        // どちらの状態かを厳密には作り分けない。
        await hangingGate;
        return [
          { id: 'c1', issueId, author: 'agent', text: `PR: ${PR_URL}`, createdAt: updatedAt },
        ];
      }),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'other' }) as const),
    };
    const logWarn = vi.fn();

    const badges = await getPrBadges(cache, commentReader, prStatusReader, {
      logWarn,
      overallTimeoutMs: 30,
    });

    // 6チケット全部が応答に含まれる —— 以前は「走査が時間内に終わらなかった」
    // チケットは badgesByTicket に一切エントリが無いまま応答から消え、「PRが無い」
    // チケットと区別が付かなかった。
    expect(badges).toHaveLength(1 + hangingIds.length);

    const fastBadge = badges.find((badge) => badge.ticketId === fastId);
    expect(fastBadge?.url).toBe(PR_URL);

    for (const hangingId of hangingIds) {
      const hangingBadge = badges.find((badge) => badge.ticketId === hangingId);
      expect(hangingBadge).toBeDefined();
      expect(hangingBadge?.url).toBeNull();
      expect(hangingBadge?.status).toBeNull();
    }

    // 後片付け: バックグラウンドの継続処理 (release 待ちの listComments) を
    // 終わらせてから解放する (未処理の pending promise を残さない)。
    releaseHanging?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
