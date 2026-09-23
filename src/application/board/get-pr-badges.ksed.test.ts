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

// bdboard-ksed 用のテストをここへ切り出した (get-pr-badges.sgpa.test.ts / get-close-evidence
// と同じ命名規約 <basename>.<concern>.test.ts に倣う)。fixture ヘルパーは
// get-pr-badges.test.ts / get-pr-badges.sgpa.test.ts 側にも同名のものがあるが、テスト
// ファイル間の共有ヘルパーモジュールを新設するリスクより単純な複製の方がこの規模では
// 安全と判断した (bdboard-sgpa の同種の判断を踏襲)。

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

describe('getPrBadges: statusGate joiners do not consume a permit (bdboard-ksed)', () => {
  it('acquires the statusGate exactly once for 4 tickets sharing one in-flight PR URL, even with only 1 permit available', async () => {
    // 修正前は resolvePrStatus を呼ぶ前に get-pr-badges.ts が無条件に statusGate.acquire()
    // していたため、in-flight 共有で gh 起動を1回に抑えられていても、相乗りするだけの
    // 3件がそれぞれゲートの枠を (フェッチ完了まで) 占有していた。修正後は実際に gh を
    // 起動する1件だけがゲートに触れる。
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const sharedUrl = 'https://github.com/xiaotiantakumi/bdboard/pull/700';
    cache.putProject({
      project: a,
      tickets: Array.from({ length: 4 }, (_, index) =>
        makeTicket({ id: `bdboard-ksed-shared-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
      ),
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });

    const commentReader: CommentReader = {
      listComments: vi.fn(async (_rootPath, issueId) => [
        { id: 'c1', issueId, author: 'agent', text: `PR: ${sharedUrl}`, createdAt: updatedAt },
      ]),
    };

    // 実行がオーバーラップするよう、わずかに遅延させて解決する (在来の
    // 'launches gh only once when multiple tickets share the same PR URL concurrently'
    // テストと同じ手法)。
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(
        async () =>
          new Promise<{ status: { state: 'open'; checkStatus: 'pass' } }>((resolve) => {
            setTimeout(() => resolve({ status: { state: 'open', checkStatus: 'pass' } }), 20);
          }),
      ),
    };

    const statusCache = new PrBadgeStatusCache();
    // statusFetchConcurrency=1: もし相乗りする3件もゲートを acquire していたら、
    // 4件全部が(直列に)ゲートを取り合うことになり、この後の acquireSpy の呼び出し
    // 回数が1件では収まらない。
    const gates = createPrBadgeGates({ statusFetchConcurrency: 1 });
    const acquireSpy = vi.spyOn(gates.statusGate, 'acquire');

    const badges = await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
      gates,
    });

    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);
    // 本題: 実際に gh を起動した1件だけがゲートを acquire している。相乗りする
    // 3件は isInFlight===true を見て、ゲートに一切触れずに共有 Promise を待つだけ。
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(badges).toHaveLength(4);
    expect(badges.every((badge) => badge.status?.state === 'open')).toBe(true);
  });
});

describe('getPrBadges: statusGate concurrency cap still holds after the gate moved inside resolvePrStatus (bdboard-ksed)', () => {
  it('never runs more concurrent gh status launches than statusFetchConcurrency for distinct PR URLs', async () => {
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const urls = Array.from(
      { length: 6 },
      (_, index) => `https://github.com/xiaotiantakumi/bdboard/pull/${910 + index}`,
    );
    cache.putProject({
      project: a,
      tickets: Array.from({ length: 6 }, (_, index) =>
        makeTicket({ id: `bdboard-ksed-cap-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
      ),
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    let activeCount = 0;
    const maxObserved = { value: 0 };
    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(async () => {
        activeCount += 1;
        maxObserved.value = Math.max(maxObserved.value, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeCount -= 1;
        return { status: { state: 'open', checkStatus: 'pass' } } as const;
      }),
    };

    const statusCache = new PrBadgeStatusCache();
    const badges = await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
      statusFetchConcurrency: 2,
    });

    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(6);
    expect(maxObserved.value).toBeLessThanOrEqual(2);
    expect(maxObserved.value).toBeGreaterThan(1);
    expect(badges.every((badge) => badge.status?.state === 'open')).toBe(true);
  });
});

describe('getPrBadges: background continuation after timeout is not capped at maxNewFetchesPerCall (bdboard-ksed)', () => {
  it(
    'keeps launching new gh status fetches in the background past maxNewFetchesPerCall once the ' +
      'response has already timed out, while still bounding concurrent launches via statusGate',
    async () => {
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      const updatedAt = new Date('2026-06-01T12:00:00.000Z');
      const ticketCount = 6;
      const urls = Array.from(
        { length: ticketCount },
        (_, index) => `https://github.com/xiaotiantakumi/bdboard/pull/${920 + index}`,
      );
      cache.putProject({
        project: a,
        tickets: Array.from({ length: ticketCount }, (_, index) =>
          makeTicket({ id: `bdboard-ksed-bg-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
        ),
        fingerprint: 'fp-a',
        fetchedAt: updatedAt,
      });
      const tickets = cache.listProjects()[0]!.tickets;

      // コメント解決を意図的に遅くする (30ms) —— overallTimeoutMs (5ms) が、どの
      // チケットもまだ resolvePrStatus に到達する前に (つまり maxNewFetchesPerCall を
      // 1件も消費していない状態で) 来るようにするため。本番の実データでも、
      // commentGate のスループット (並列3) がボトルネックで、応答予算が尽きる時点では
      // まだステータス取得に着手できていないチケットが大半、という構造を模している。
      const urlByTicketId = new Map(tickets.map((ticket, index) => [ticket.id, urls[index]]));
      const commentReader: CommentReader = {
        listComments: vi.fn(async (_rootPath, issueId: string) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return [
            {
              id: 'c1',
              issueId,
              author: 'agent',
              text: `PR: ${urlByTicketId.get(issueId)}`,
              createdAt: updatedAt,
            },
          ];
        }),
      };

      let activeCount = 0;
      const maxObserved = { value: 0 };
      const prStatusReader: PrStatusReader = {
        getPrStatus: vi.fn(async () => {
          activeCount += 1;
          maxObserved.value = Math.max(maxObserved.value, activeCount);
          await new Promise((resolve) => setTimeout(resolve, 15));
          activeCount -= 1;
          return { status: { state: 'open', checkStatus: 'pass' } } as const;
        }),
      };

      const statusCache = new PrBadgeStatusCache();
      const logWarn = vi.fn();

      const badges = await getPrBadges(cache, commentReader, prStatusReader, {
        statusCache,
        logWarn,
        maxNewFetchesPerCall: 2,
        statusFetchConcurrency: 2,
        overallTimeoutMs: 5,
      });

      // 応答時点ではまだ1件も解決していない (コメント解決が30ms、予算が5msなので)。
      // bdboard-3znc のプレースホルダとして全件は残る (省略されない)。
      expect(badges).toHaveLength(ticketCount);
      expect(badges.every((badge) => badge.url === null)).toBe(true);
      expect(prStatusReader.getPrStatus).not.toHaveBeenCalled();

      // バックグラウンド継続が6件全部のコメント解決 (最大2バッチ×30ms) + ステータス
      // 取得 (最大3バッチ×15ms、concurrency=2) を終えるまで待つ。固定 sleep だと
      // 負荷の高いマシン/CIでフレークしうるので (opus レビュー指摘)、条件が満たされる
      // まで短い間隔でポーリングする vi.waitFor を使う。
      await vi.waitFor(
        () => {
          expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(ticketCount);
        },
        { timeout: 2000, interval: 10 },
      );

      // 本題: maxNewFetchesPerCall=2 のままなら2件で打ち止めのはずが、応答タイムアウト
      // 後のバックグラウンド継続ではこの上限を外しているので6件全部が解決する。
      expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(ticketCount);
      // ただし同時に起動できる数そのものは statusGate (concurrency=2) で引き続き
      // 絞られている —— gh の同時起動数が無制限になったわけではない。
      expect(maxObserved.value).toBeLessThanOrEqual(2);
      expect(maxObserved.value).toBeGreaterThan(1);
    },
  );
});

describe('getPrBadges: maxNewFetchesPerCall is ignored whenever overallTimeoutMs is set, even with a warm comment cache (bdboard-ksed)', () => {
  it(
    'launches gh for all tickets past maxNewFetchesPerCall when comment resolution is instant ' +
      '(no timeout race needed), while still bounding concurrency via statusGate',
    async () => {
      // opus レビュー指摘 (finding 2): 上の 'background continuation after timeout' テストは
      // コメント解決を意図的に30ms遅くしていたため、「応答タイムアウト後に外れる」という
      // 当初の (誤りが見つかった) 設計しか検証できていなかった。本番の
      // /api/pr-links はコメントキャッシュをリクエストをまたいで共有するため、2回目
      // 以降の呼び出しではコメント解決がキャッシュヒットでほぼ一瞬に終わり、
      // maxNewFetchesPerCall の予算はタイムアウトよりずっと前 (マイクロタスク単位) に
      // 尽きてしまう —— これが実際に踏んだ本番のシナリオであり、この修正の本体
      // (statusBudget を overallTimeoutMs 指定時は最初から無制限にする) が対象とする
      // ケースそのもの。コメント解決を遅延ゼロにして、このケースを直接検証する。
      const cache = createFakeBoardCache();
      const a = project('proj-a', '/projects/a');
      const updatedAt = new Date('2026-06-01T12:00:00.000Z');
      const ticketCount = 6;
      const urls = Array.from(
        { length: ticketCount },
        (_, index) => `https://github.com/xiaotiantakumi/bdboard/pull/${930 + index}`,
      );
      cache.putProject({
        project: a,
        tickets: Array.from({ length: ticketCount }, (_, index) =>
          makeTicket({ id: `bdboard-ksed-warm-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
        ),
        fingerprint: 'fp-a',
        fetchedAt: updatedAt,
      });
      const tickets = cache.listProjects()[0]!.tickets;
      // 遅延なし = キャッシュヒットでコメント解決が一瞬に終わる状況のアナロジー。
      const commentReader = commentReaderForUrls(tickets, urls);

      let activeCount = 0;
      const maxObserved = { value: 0 };
      const prStatusReader: PrStatusReader = {
        getPrStatus: vi.fn(async () => {
          activeCount += 1;
          maxObserved.value = Math.max(maxObserved.value, activeCount);
          await new Promise((resolve) => setTimeout(resolve, 15));
          activeCount -= 1;
          return { status: { state: 'open', checkStatus: 'pass' } } as const;
        }),
      };

      const statusCache = new PrBadgeStatusCache();

      await getPrBadges(cache, commentReader, prStatusReader, {
        statusCache,
        maxNewFetchesPerCall: 2,
        statusFetchConcurrency: 2,
        // overallTimeoutMs を指定しているだけで十分 —— 実際にタイムアウトが発火
        // するかどうかとは無関係に、maxNewFetchesPerCall は最初から適用されない
        // はずなので、ここでは十分大きい値にしてタイムアウト自体は起きないように
        // しておく (このテストの主張は「タイムアウト後だから外れる」ではなく
        // 「overallTimeoutMs 指定時は最初から掛からない」なので、タイムアウトの
        // 発火有無を主張から切り離す)。
        overallTimeoutMs: 5_000,
      });

      // 本題: maxNewFetchesPerCall=2 なのに、タイムアウトすら発火していないこの
      // 呼び出し内で6件全部が gh を起動できている。
      expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(ticketCount);
      expect(maxObserved.value).toBeLessThanOrEqual(2);
      expect(maxObserved.value).toBeGreaterThan(1);
    },
  );

  it('still enforces maxNewFetchesPerCall when overallTimeoutMs is not set at all', async () => {
    // 対照実験: overallTimeoutMs を渡さない (完了まで同期的に待つ) 呼び出しでは、
    // 従来通り maxNewFetchesPerCall で総数が絞られる — この修正が「常に無制限」に
    // 後退していないことの回帰ガード。
    const cache = createFakeBoardCache();
    const a = project('proj-a', '/projects/a');
    const updatedAt = new Date('2026-06-01T12:00:00.000Z');
    const ticketCount = 6;
    const urls = Array.from(
      { length: ticketCount },
      (_, index) => `https://github.com/xiaotiantakumi/bdboard/pull/${940 + index}`,
    );
    cache.putProject({
      project: a,
      tickets: Array.from({ length: ticketCount }, (_, index) =>
        makeTicket({ id: `bdboard-ksed-nolimit-${index}`, projectId: a.id, commentCount: 1, updatedAt }),
      ),
      fingerprint: 'fp-a',
      fetchedAt: updatedAt,
    });
    const tickets = cache.listProjects()[0]!.tickets;
    const commentReader = commentReaderForUrls(tickets, urls);

    const prStatusReader: PrStatusReader = {
      getPrStatus: vi.fn(
        async () => ({ status: { state: 'open', checkStatus: 'pass' } }) as const,
      ),
    };

    const statusCache = new PrBadgeStatusCache();
    const logWarn = vi.fn();

    await getPrBadges(cache, commentReader, prStatusReader, {
      statusCache,
      logWarn,
      maxNewFetchesPerCall: 2,
      statusFetchConcurrency: 2,
      // overallTimeoutMs を渡さない。
    });

    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(2);
  });
});
