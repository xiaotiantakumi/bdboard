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
import { getPrBadges, PrBadgeStatusCache } from './get-pr-badges.js';

// bdboard-sso1.87 用のテストをここへ切り出した (get-pr-badges.test.ts の ESLint
// max-lines 上限、eslint.config.mjs の MAX_LINES_ALLOWLIST 超過対応)。対象は
// bdboard-7ln6 系: gh レート制限のサーキットブレーカー/新規フェッチ予算/in-flight
// URL 共有/非レート制限失敗のネガティブキャッシュバックオフ/merged+pending 恒久化。
// hygiene.aggregate.test.ts / hygiene.shared.test.ts、get-pr-badges.sgpa.test.ts /
// get-pr-badges.ksed.test.ts の分割方針と同じ命名規約 (<basename>.<concern>.test.ts)
// に倣う。フィクスチャ用ヘルパーは get-pr-badges.test.ts 側にも同名のものがあるが、
// テストファイル間の共有ヘルパーモジュールを新設するリスクより単純な複製の方が
// この規模では安全と判断した (このファイルでしか使わない4つの小さい関数のみ)。

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

function makeManyProjectTickets(count: number): {
  readonly cache: BoardCache & { readonly entries: Map<string, CachedProject> };
  readonly urls: readonly string[];
} {
  const cache = createFakeBoardCache();
  const a = project('proj-a', '/projects/a');
  const updatedAt = new Date('2026-06-01T12:00:00.000Z');
  const urls = Array.from(
    { length: count },
    (_, index) => `https://github.com/xiaotiantakumi/bdboard/pull/${900 + index}`,
  );
  cache.putProject({
    project: a,
    tickets: Array.from({ length: count }, (_, index) =>
      makeTicket({ id: `bdboard-rl-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
    ),
    fingerprint: 'fp-a',
    fetchedAt: updatedAt,
  });
  return { cache, urls };
}

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


describe('getPrBadges: gh rate-limit circuit breaker (bdboard-7ln6)', () => {
  it('trips the breaker on the first rate-limit and skips gh entirely for the rest while open', async () => {
    // 6 チケット・6 個の別々の PR URL。statusFetchConcurrency (ここでは明示的に 3 に
    // 固定 —— bdboard-se3v でコメント取得の並列数とステータス取得の並列数を分離した
    // ため、既定値 (8) だと6件全部が同一バッチで gh を起動してしまい、この
    // テストの前提 (1バッチ目の rate-limit 検知後、2バッチ目は gh を1回も起動しない)
    // が成立しなくなる) を超える件数を用意して検証する (bdboard-7ln6 #2)。
    const { cache, urls } = makeManyProjectTickets(6);
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'rate-limit' }) as const),
    };

    let fakeNow = 0;
    const logWarn = vi.fn();
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      circuitInitialCooldownMs: 15 * 60_000,
      // サーキットブレーカーの警告は PrBadgeStatusCache 自身が出す (getPrBadges の
      // logWarn オプションとは別経路)。両方に同じ関数を注入して1本で検証する。
      logWarn,
    });

    const badges = await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
      logWarn,
      statusFetchConcurrency: 3,
    });

    // 有界であること: 6件中、実際に gh が起動されたのは statusFetchConcurrency (3) 以下。
    // ブレーカーが開いた後は残りが1回も起動されない —— 新しいディスパッチのたびに
    // (runWithConcurrencyLimit が枠が空くたびに次を積む挙動) isCircuitOpen() が
    // 再評価されるので、待機中だった分は正しくスキップされる。
    const callCount = (prStatusReader.getPrStatus as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCount).toBeGreaterThan(0);
    expect(callCount).toBeLessThanOrEqual(3);
    expect(badges).toHaveLength(6);
    expect(badges.every((badge) => badge.status === null)).toBe(true);
    expect(statusCache.isCircuitOpen()).toBe(true);
    expect(
      logWarn.mock.calls.some((call) =>
        (call[0] as string).includes('rate limit'),
      ),
    ).toBe(true);
  });

  it('allows more than 3 concurrent gh launches when statusFetchConcurrency raises the limit (bdboard-se3v)', async () => {
    // コメント取得の並列数 (COMMENT_FETCH_CONCURRENCY=3) とは独立に、ステータス取得の
    // 並列数を上げられることを直接検証する。6件・statusFetchConcurrency=6 なら、
    // 理論上は6件全部が同時に gh を起動できる (旧設計ではコメント取得と直列に結合
    // していたため、ここは最大3までしか起動できなかった)。
    const { cache, urls } = makeManyProjectTickets(6);
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    let activeCount = 0;
    const maxObserved = { value: 0 };
    let resolveAll: (() => void) | undefined;
    const allStarted = new Promise<void>((resolve) => {
      resolveAll = resolve;
    });
    let startedCount = 0;

    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => {
        activeCount += 1;
        maxObserved.value = Math.max(maxObserved.value, activeCount);
        startedCount += 1;
        if (startedCount === 6) {
          resolveAll?.();
        }
        await allStarted;
        activeCount -= 1;
        return { status: { state: 'open', checkStatus: 'pass' } } as const;
      }),
    };

    const badges = await getPrBadges(cache, commentReader, prStatusReader, {
      statusFetchConcurrency: 6,
    });

    expect(maxObserved.value).toBe(6);
    expect(badges).toHaveLength(6);
    expect(badges.every((badge) => badge.status !== null)).toBe(true);
  });

  it('calls gh zero times on a fresh request while the breaker is open', async () => {
    const { cache, urls } = makeManyProjectTickets(1);
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    let fakeNow = 0;
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      circuitInitialCooldownMs: 15 * 60_000,
    });

    // 1回目: rate-limit を踏んでブレーカーを開く。
    const rateLimitedReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'rate-limit' }) as const),
    };
    await getPrBadges(cache, commentReader, rateLimitedReader, { statusCache });
    expect(statusCache.isCircuitOpen()).toBe(true);

    // 2回目 (同じ now、クールダウン中): 別の reader を渡し、1回も呼ばれないことを
    // 直接確認する (呼ばれていたら成功レスポンスを返してしまうダミー)。
    fakeNow += 1_000;
    const neverCalledReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: { state: 'open', checkStatus: 'pass' } }) as const),
    };
    const badges = await getPrBadges(cache, commentReader, neverCalledReader, { statusCache });

    expect(neverCalledReader.getPrStatus).not.toHaveBeenCalled();
    expect(badges[0]?.status).toBeNull();
  });

  it('recovers after the cooldown elapses and closes the breaker on the next success', async () => {
    const { cache, urls } = makeManyProjectTickets(1);
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    let fakeNow = 0;
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      circuitInitialCooldownMs: 1_000,
    });

    const rateLimitedReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'rate-limit' }) as const),
    };
    await getPrBadges(cache, commentReader, rateLimitedReader, { statusCache });
    expect(statusCache.isCircuitOpen()).toBe(true);

    // クールダウン経過前: まだ open。
    fakeNow += 500;
    expect(statusCache.isCircuitOpen()).toBe(true);

    // ちょうど境界 (now === circuitOpenUntil): 開いた瞬間からクールダウン ms
    // 経過した時点はもう open ではない (< の境界を厳密に固定する)。
    fakeNow += 500;
    expect(statusCache.isCircuitOpen()).toBe(false);

    // クールダウン経過後: half-open で次の1回は通す。
    fakeNow += 100;
    expect(statusCache.isCircuitOpen()).toBe(false);

    const healthyReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: { state: 'open', checkStatus: 'pass' } }) as const),
    };
    const badges = await getPrBadges(cache, commentReader, healthyReader, { statusCache });

    expect(healthyReader.getPrStatus).toHaveBeenCalledTimes(1);
    expect(badges[0]?.status).toEqual({ state: 'open', checkStatus: 'pass' });
    expect(statusCache.isCircuitOpen()).toBe(false);
  });

  it('doubles the cooldown on a repeat rate-limit without an intervening success', async () => {
    const { cache, urls } = makeManyProjectTickets(1);
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    let fakeNow = 0;
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      circuitInitialCooldownMs: 1_000,
      circuitMaxCooldownMs: 60_000,
    });
    const rateLimitedReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'rate-limit' }) as const),
    };

    // 1回目のトリップ: 1000ms のクールダウン。
    await getPrBadges(cache, commentReader, rateLimitedReader, { statusCache });
    fakeNow += 1_001; // クールダウン明け
    expect(statusCache.isCircuitOpen()).toBe(false);

    // half-open の probe も rate-limit → 2回目のトリップは倍の 2000ms になるはず。
    await getPrBadges(cache, commentReader, rateLimitedReader, { statusCache });
    fakeNow += 1_500; // 1000ms 明けのタイミングではまだ閉じない (倍化されていれば)
    expect(statusCache.isCircuitOpen()).toBe(true);

    fakeNow += 600; // 合計 2100ms 経過 → 2000ms のクールダウンは明けている
    expect(statusCache.isCircuitOpen()).toBe(false);
  });

  it('does not let a concurrent success for a different URL close the breaker mid-cooldown (bdboard-v538)', async () => {
    // COMMENT_FETCH_CONCURRENCY=3 のもとで rate-limit と成功が同一バッチで
    // 並行起動されるケースの再現。url1 は rate-limit、url2 は (確実に url1 の
    // 結果より後に解決するよう遅延させた) 成功を返す。修正前は url2 の成功が
    // recordResult 経由で無条件に closeCircuit() を呼び、トリップ直後の
    // クールダウンが即座にリセットされてしまっていた。
    const { cache, urls } = makeManyProjectTickets(2);
    const [rateLimitedUrl, successUrl] = urls;
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async (url: string) => {
        if (url === rateLimitedUrl) {
          return { status: null, reason: 'rate-limit' } as const;
        }
        // 確実に rate-limit の結果が先に record されるよう、実タイマーで遅延させる。
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { status: { state: 'open', checkStatus: 'pass' } } as const;
      }),
    };

    const fakeNow = 0;
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      circuitInitialCooldownMs: 15 * 60_000,
    });

    const badges = await getPrBadges(cache, commentReader, prStatusReader, { statusCache });

    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);
    // 本題: url2 の成功が届いた後も、まだクールダウン中のブレーカーは開いたまま。
    expect(statusCache.isCircuitOpen()).toBe(true);
    // successUrl 自体の badge は取れているはず (呼び出し自体は成功している)。
    const successBadge = badges.find((badge) => badge.url === successUrl);
    expect(successBadge?.status).toEqual({ state: 'open', checkStatus: 'pass' });
  });
});

describe('getPrBadges: per-request new-fetch budget (bdboard-7ln6 #6)', () => {
  it('caps new gh launches per call and drains the rest across subsequent calls', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const urls = Array.from(
      { length: 5 },
      (_, index) => `https://github.com/xiaotiantakumi/bdboard/pull/${800 + index}`,
    );
    cache.putProject({
      project: a,
      tickets: Array.from({ length: 5 }, (_, index) =>
        makeTicket({ id: `bdboard-budget-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
      ),
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: { state: 'open', checkStatus: 'pass' } }) as const),
    };

    const statusCache = new PrBadgeStatusCache();
    const logWarn = vi.fn();

    // 1回目: 上限2件だけ新規起動。5件中3件は今回 URL のみのバッジで妥協する。
    const firstBadges = await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
      logWarn,
      maxNewFetchesPerCall: 2,
    });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);
    expect(firstBadges.filter((badge) => badge.status !== null)).toHaveLength(2);
    expect(firstBadges.filter((badge) => badge.status === null)).toHaveLength(3);
    expect(
      logWarn.mock.calls.some((call) => (call[0] as string).includes('deferred')),
    ).toBe(true);

    // 2回目: 前回キャッシュされた2件はヒット、新規予算(2件)は前回見送った分から
    // 消費される。上限を超えて一度に起動しないこと自体がこのテストの本旨。
    const secondBadges = await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
      maxNewFetchesPerCall: 2,
    });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(4);
    expect(secondBadges.filter((badge) => badge.status !== null)).toHaveLength(4);

    // 3回目: 残り1件を消化しきる。
    await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
      maxNewFetchesPerCall: 2,
    });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(5);
  });
});

describe('getPrBadges: in-flight sharing for duplicate URLs (bdboard-7ln6 #6)', () => {
  it('launches gh only once when multiple tickets share the same PR URL concurrently', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const sharedUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/700';
    cache.putProject({
      project: a,
      tickets: Array.from({ length: 4 }, (_, index) =>
        makeTicket({ id: `bdboard-shared-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
      ),
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath, issueId) => [
        {
          id: 'c1',
          issueId,
          author: 'agent',
          text: `PR: ${sharedUrl}`,
          createdAt: updatedAt,
        },
      ]),
    };

    // 実行がオーバーラップするよう、わずかに遅延させて解決する。
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(
        async () =>
          new Promise<{ status: { state: 'open'; checkStatus: 'pass' } }>((resolve) => {
            setTimeout(() => resolve({ status: { state: 'open', checkStatus: 'pass' } }), 20);
          }),
      ),
    };

    const statusCache = new PrBadgeStatusCache();
    const badges = await getPrBadges(cache, commentReader, prStatusReader, { statusCache });

    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);
    expect(badges).toHaveLength(4);
    expect(
      badges.every((badge) => badge.status !== null && badge.status.state === 'open'),
    ).toBe(true);
  });
});

describe('PrBadgeStatusCache: negative-cache backoff for non-rate-limit failures (bdboard-7ln6 #3)', () => {
  it('doubles the negative-cache TTL on each consecutive failure, capped at negativeCacheMaxMs', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const url = 'https://github.com/xiaotiantakumi/bdboard/pull/600';
    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-nf', projectId: a.id, commentCount: 1, updatedAt })],
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        { id: 'c1', issueId: 'bdboard-nf', author: 'agent', text: `PR: ${url}`, createdAt: updatedAt },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => ({ status: null, reason: 'not-found' }) as const),
    };

    let fakeNow = 0;
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      ttlMs: 60_000,
      negativeCacheMaxMs: 10_000_000,
    });

    // 1回目: 失敗streak=1、TTL=60_000。
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

    // TTL 内 (59_999ms 後): キャッシュヒットで再取得しない。
    fakeNow = 59_999;
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

    // TTL 超過 (60_001ms 後): 再取得。streak=2、TTL=120_000 に倍化。
    fakeNow = 60_001;
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);

    // 120_000ms 未満ならまだキャッシュヒット (60秒固定なら再取得されてしまうはず)。
    fakeNow = 60_001 + 119_999;
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);

    // 120_000ms 超過で再取得。streak=3。
    fakeNow = 60_001 + 120_001;
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(3);
  });
});

describe('PrBadgeStatusCache: merged/closed+pending eventual permanence (bdboard-7ln6 #4)', () => {
  it('refetches merged+pending up to mergedPendingMaxRetries, then freezes permanently', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const url = 'https://github.com/xiaotiantakumi/bdboard/pull/500';
    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-mp', projectId: a.id, commentCount: 1, updatedAt })],
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });
    const commentReader: CommentReader = {
      listComments: vi.fn(async () => [
        { id: 'c1', issueId: 'bdboard-mp', author: 'agent', text: `PR: ${url}`, createdAt: updatedAt },
      ]),
    };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(
        async () => ({ status: { state: 'merged', checkStatus: 'pending' } }) as const,
      ),
    };

    let fakeNow = 0;
    const statusCache = new PrBadgeStatusCache({
      now: () => fakeNow,
      mergedPendingTtlMs: 1_000,
      mergedPendingMaxRetries: 2,
    });

    // 1回目: retries=1 (< 2), 恒久化しない。
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);

    // TTL 超過で2回目: retries=2 (>= 2) → 恒久化。
    fakeNow = 1_001;
    await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);

    // どれだけ時間が経っても (恒久キャッシュなので) 再取得されない。
    fakeNow += 999_999_999;
    const finalBadges = await getPrBadges(cache, commentReader, prStatusReader, { statusCache });
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);
    expect(finalBadges[0]?.status).toEqual({ state: 'merged', checkStatus: 'pending' });
  });
});
