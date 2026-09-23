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
import type { PrStatus } from '../../domain/pr-link.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';
import { getPrBadges, PrBadgeCommentCache, PrBadgeStatusCache } from './get-pr-badges.js';

// bdboard-se3v (overallTimeoutMs による時間予算超過時の部分バッジ返却/
// バックグラウンド継続) のテストを bdboard-sso1.87 でここへ切り出した
// (get-pr-badges.test.ts の ESLint max-lines 上限、eslint.config.mjs の
// MAX_LINES_ALLOWLIST 超過対応)。hygiene.aggregate.test.ts /
// hygiene.shared.test.ts、get-pr-badges.sgpa.test.ts / get-pr-badges.ksed.test.ts の
// 分割方針と同じ命名規約 (<basename>.<concern>.test.ts) に倣う。project()/
// createFakeBoardCache()/PR_URL は get-pr-badges.test.ts 側にも同名のものがあるが、
// テストファイル間の共有ヘルパーモジュールを新設するリスクより単純な複製の方が
// この規模では安全と判断した。PrBadgeCommentCache.prune は overallTimeoutMs と
// 無関係 (bdboard-5v6p 起源) なので get-pr-badges.test.ts 側に残した。

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


describe('getPrBadges: overallTimeoutMs (bdboard-se3v)', () => {
  it('returns partial badges when the time budget is exceeded, and warms the cache in the background for the next call', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const fastUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/701';
    const slowUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/702';

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-fast', projectId: a.id, commentCount: 1, updatedAt }),
        makeTicket({ id: 'bdboard-slow', projectId: a.id, commentCount: 1, updatedAt }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath: string, issueId: string) => [
        {
          id: 'c1',
          issueId,
          author: 'agent',
          text: `PR: ${issueId === 'bdboard-fast' ? fastUrl : slowUrl}`,
          createdAt: updatedAt,
        },
      ]),
    };

    // fastUrl は即座に解決、slowUrl はオーバーオール予算より後にしか解決しない
    // (実タイマーで遅延) —— タイムアウト時点で「分かっている分だけ」返ることを見る。
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async (url: string) => {
        if (url === fastUrl) {
          return { status: { state: 'open', checkStatus: 'pass' } } as const;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { status: { state: 'open', checkStatus: 'pass' } } as const;
      }),
    };

    const statusCache = new PrBadgeStatusCache();
    const logWarn = vi.fn();

    const firstBadges = await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
      logWarn,
      overallTimeoutMs: 30,
    });

    // 両チケットとも PR URL は Pass 1 (コメント解決) の時点で分かっているので、
    // タイムアウトしてもどちらのバッジも消えない —— slowUrl 側は status:null の
    // ままで「未取得」を表す (既存の意味の使い回し。新規フィールドは足さない)。
    expect(firstBadges).toHaveLength(2);
    const fastBadge = firstBadges.find((badge) => badge.url === fastUrl);
    const slowBadge = firstBadges.find((badge) => badge.url === slowUrl);
    expect(fastBadge?.status).toEqual({ state: 'open', checkStatus: 'pass' });
    expect(slowBadge?.status).toBeNull();
    expect(
      logWarn.mock.calls.some((call) => (call[0] as string).includes('time budget')),
    ).toBe(true);

    // バックグラウンドで slowUrl の取得が完了し、statusCache が温まるまで待つ。
    await new Promise((resolve) => setTimeout(resolve, 200));

    const callsForSlowUrl = (prStatusReader.getPrStatus as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === slowUrl,
    );
    expect(callsForSlowUrl).toHaveLength(1);

    // 次の呼び出し (タイムアウトなし) は両方ともキャッシュヒットで gh を再起動しない。
    const secondBadges = await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
    });
    const callsForSlowUrlAfterSecondCall = (
      prStatusReader.getPrStatus as ReturnType<typeof vi.fn>
    ).mock.calls.filter((call) => call[0] === slowUrl);
    expect(callsForSlowUrlAfterSecondCall).toHaveLength(1);
    const secondSlowBadge = secondBadges.find((badge) => badge.url === slowUrl);
    expect(secondSlowBadge?.status).toEqual({ state: 'open', checkStatus: 'pass' });
  });

  it('does not truncate results when the work finishes before the time budget', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-pr', projectId: a.id, commentCount: 1 })],
      fingerprint: 'fp-a',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        {
          id: 'c1',
          issueId: 'bdboard-pr',
          author: 'agent',
          text: `PR: ${PR_URL}`,
          createdAt: new Date('2026-06-01T12:00:00.000Z'),
        },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: { state: 'open', checkStatus: 'pass' } }) as const),
    };
    const logWarn = vi.fn();

    const badges = await getPrBadges(cache, commentReader, prStatusReader, {
      logWarn,
      overallTimeoutMs: 5_000,
    });

    expect(badges).toEqual([
      { ticketId: 'bdboard-pr', projectId: 'proj-a', url: PR_URL, status: { state: 'open', checkStatus: 'pass' } },
    ]);
    expect(
      logWarn.mock.calls.some((call) => (call[0] as string).includes('time budget')),
    ).toBe(false);
  });

  it(
    'lets a fast ticket reach gh and resolve its status even while a different ' +
      "ticket's comment fetch is still slow (bdboard-se3v regression: an earlier " +
      'two-pass design fully resolved every URL before starting any gh call, so a ' +
      'single slow bd comment read could starve every gh launch until the whole ' +
      'time budget was gone)',
    async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      const updatedAt = new Date('2026-06-01T12:00:00.000Z');
      const fastUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/711';

      cache.putProject({
        project: a,
        tickets: [
          makeTicket({ id: 'bdboard-fast-comment', projectId: a.id, commentCount: 1, updatedAt }),
          makeTicket({ id: 'bdboard-slow-comment', projectId: a.id, commentCount: 1, updatedAt }),
        ],
        fingerprint: 'fp-a',
        fetchedAt: updatedAt,
      });

      // bdboard-slow-comment 側の bd コメント読み取りだけをわざと遅くする。
      // COMMENT_FETCH_CONCURRENCY=3 なので両チケットとも同時に in-flight になれる —
      // bdboard-fast-comment 側は即座に URL が分かるはず。
      const commentReader: CommentReader = {
        listComments: vi.fn(async (_rootPath: string, issueId: string) => {
          if (issueId === 'bdboard-slow-comment') {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          return [
            {
              id: 'c1',
              issueId,
              author: 'agent',
              text: `PR: ${fastUrl}`,
              createdAt: updatedAt,
            },
          ];
        }),
      };
      const prStatusReader: PrStatusReader = {
        getPrStatus: vi.fn(async () => ({ status: { state: 'open', checkStatus: 'pass' } }) as const),
      };
      const logWarn = vi.fn();

      // 予算 (50ms) は bdboard-slow-comment の遅延 (200ms) より短いのでタイムアウトする
      // が、bdboard-fast-comment の URL 解決 + gh 起動は50msよりずっと速く終わるはず。
      const badges = await getPrBadges(cache, commentReader, prStatusReader, {
        logWarn,
        overallTimeoutMs: 50,
      });

      const fastBadge = badges.find((badge) => badge.url === fastUrl);
      expect(fastBadge).toBeDefined();
      // ここが本題: bdboard-slow-comment がまだ bd から読み終えていない間に、
      // bdboard-fast-comment の gh 起動が完了して status が埋まっている必要がある。
      expect(fastBadge?.status).toEqual({ state: 'open', checkStatus: 'pass' });
      expect(
        logWarn.mock.calls.some((call) => (call[0] as string).includes('time budget')),
      ).toBe(true);

      // バックグラウンドの継続処理が終わるまで待ってから片付ける (未処理の reject を
      // 残さない)。
      await new Promise((resolve) => setTimeout(resolve, 250));
    },
  );

  it(
    'returns an already-cached status for one ticket even while statusGate is fully ' +
      "occupied by a slow gh call for a different ticket (bdboard-se3v regression: " +
      "resolvePrStatus's cache check happened only after acquiring statusGate, so a cache " +
      'hit still queued behind an unrelated slow gh launch and could come back as ' +
      'unfetched/null — opus review finding M1)',
    async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      const updatedAt = new Date('2026-06-01T12:00:00.000Z');
      const slowUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/801';
      const cachedUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/802';

      const commentReader: CommentReader = {
        listComments: vi.fn(async (_rootPath: string, issueId: string) => [
          {
            id: 'c1',
            issueId,
            author: 'agent',
            text: `PR: ${issueId === 'bdboard-slow-status' ? slowUrl : cachedUrl}`,
            createdAt: updatedAt,
          },
        ]),
      };

      let slowShouldDelay = false;
      const prStatusReader: PrStatusReader = {
        getPrStatus: vi.fn(async (url: string) => {
          if (url === slowUrl && slowShouldDelay) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          return { status: { state: 'merged', checkStatus: 'pass' } satisfies PrStatus };
        }),
      };

      const commentCache = new PrBadgeCommentCache();
      const statusCache = new PrBadgeStatusCache();

      // 1回目の呼び出し: bdboard-cached-status だけを盤面に置いてインスタントに解決させ、
      // cachedUrl のステータスを statusCache に乗せておく (merged は terminal なので
      // 以降ずっとキャッシュされる)。この時点では bdboard-slow-status はまだ存在しない
      // ので slowUrl はキャッシュされない。
      cache.putProject({
        project: a,
        tickets: [
          makeTicket({ id: 'bdboard-cached-status', projectId: a.id, commentCount: 1, updatedAt }),
        ],
        fingerprint: 'fp-a',
        fetchedAt: updatedAt,
      });
      await getPrBadges(cache, commentReader, prStatusReader, { commentCache, statusCache });
      expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

      // 2回目: bdboard-slow-status を盤面に追加する (キャッシュ未保持・gh 起動が必要)。
      // workItems の先頭に置くことで、statusFetchConcurrency=1 の唯一の枠を先に掴む側に
      // する。修正前の実装だと cachedUrl 側もキャッシュ確認の前に statusGate.acquire()
      // で待たされ、50ms のタイムアウトに巻き込まれて status:null (未取得) になっていた。
      cache.putProject({
        project: a,
        tickets: [
          makeTicket({ id: 'bdboard-slow-status', projectId: a.id, commentCount: 1, updatedAt }),
          makeTicket({ id: 'bdboard-cached-status', projectId: a.id, commentCount: 1, updatedAt }),
        ],
        fingerprint: 'fp-a-2',
        fetchedAt: updatedAt,
      });
      slowShouldDelay = true;
      (prStatusReader.getPrStatus as ReturnType<typeof vi.fn>).mockClear();
      const badges = await getPrBadges(cache, commentReader, prStatusReader, {
        commentCache,
        statusCache,
        statusFetchConcurrency: 1,
        overallTimeoutMs: 50,
      });

      const cachedBadge = badges.find((badge) => badge.url === cachedUrl);
      expect(cachedBadge).toBeDefined();
      expect(cachedBadge?.status).toEqual({ state: 'merged', checkStatus: 'pass' });
      // 実際に gh が起動されたのは遅い方だけ (キャッシュ済みの方は起動不要)。
      expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);
      expect(prStatusReader.getPrStatus).toHaveBeenCalledWith(slowUrl);

      // バックグラウンドで走り続ける遅い gh 呼び出しが終わるまで待ってから片付ける。
      await new Promise((resolve) => setTimeout(resolve, 550));
    },
  );
});
