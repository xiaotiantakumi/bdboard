import { compareStrings } from '../../domain/compare.js';
import { extractLatestPrUrl, type PrBadge, type PrStatus } from '../../domain/pr-link.js';
import { hasCloseEvidenceMarker } from './close-evidence-marker.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import type { CommentReader } from '../ports/comment-reader.js';
import type { PrStatusReader, PrStatusResult } from '../ports/pr-status-reader.js';
import type { Ticket } from '../../domain/ticket.js';
import { describeFetchFailures, type FetchFailure } from './fetch-failure-log.js';

export interface GetPrBadgesOptions {
  readonly projectIds?: readonly string[];
  /** 取得失敗の警告ログ。未指定なら console.warn (discover-projects と同じ注入流儀)。 */
  readonly logWarn?: (message: string) => void;
  /** コメントから抽出した PR URL のインメモリキャッシュ。未指定なら毎回フルフェッチ。 */
  readonly commentCache?: PrBadgeCommentCache;
  /** gh pr view 由来の PR 状態インメモリキャッシュ。未指定なら毎回フルフェッチ。 */
  readonly statusCache?: PrBadgeStatusCache;
  /**
   * 1回の呼び出しで新規に gh を起動する上限 (in-flight 共有で乗っかれるものは含まない)。
   * 上限に達した分は今回は URL のみのバッジで妥協し、次回の呼び出し (board.changed の
   * たびに来る) に回す (bdboard-7ln6 #6)。未指定なら DEFAULT_MAX_NEW_FETCHES_PER_CALL。
   */
  readonly maxNewFetchesPerCall?: number;
}

interface PrBadgeCommentCacheEntry {
  readonly commentCount: number;
  readonly updatedAt: number;
  readonly url: string | null;
  readonly hasCloseEvidence: boolean;
}

/** チケットごとのコメント由来 PR URL を commentCount/updatedAt で無効化する薄いキャッシュ。 */
export class PrBadgeCommentCache {
  private readonly entries = new Map<string, PrBadgeCommentCacheEntry>();

  get(
    ticketId: string,
    commentCount: number,
    updatedAt: number,
  ): string | null | undefined {
    const entry = this.entries.get(ticketId);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.commentCount === commentCount && entry.updatedAt === updatedAt) {
      return entry.url;
    }
    return undefined;
  }

  set(
    ticketId: string,
    commentCount: number,
    updatedAt: number,
    url: string | null,
    hasCloseEvidence: boolean,
  ): void {
    this.entries.set(ticketId, {
      commentCount,
      updatedAt,
      url,
      hasCloseEvidence,
    });
  }

  /**
   * close 証拠 (コメントに PR:/検証: があるか) を、この PR バッジ用キャッシュから
   * 再利用する (bdboard-pkr6.16)。commentCount/updatedAt が一致しないエントリは
   * undefined (未確認)。
   *
   * 否定TTL は意図的に持たない (bdboard-pkr6.16 レビュー対応, M1)。pkr6.8 では
   * get-close-evidence.ts 自身が定期的に bd comments を叩き直す fetcher を持っており、
   * 否定結果に TTL を付けて「一定時間後に再フェッチさせる」ことで、既存コメントを
   * 編集して PR: を後付けしたケースを自己修復していた。本チケット (pkr6.16) で
   * その fetcher を丸ごと廃止したため、TTL 失効後にこのキャッシュへ書き込む
   * producer が存在しなくなった —— 一致する commentCount/updatedAt が来る
   * (新しいコメントが増える/元のコメントが編集されて updatedAt が動く) まで
   * 誰もここを更新しないので、TTL を残すと unknownKeys に落ちたまま二度と
   * 確定しなくなる = closed_without_evidence 警告が恒久的に沈黙する。
   * 「証拠なし」が事実と食い違ったまま多少長く残る (false positive 方向の劣化)
   * ほうが、警告が永久に出ない (false negative 方向) より衛生チェックとしては
   * はるかに安全な失敗方向なので、TTL は削除した。
   */
  getCloseEvidence(
    ticketId: string,
    commentCount: number,
    updatedAt: number,
  ): boolean | undefined {
    const entry = this.entries.get(ticketId);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.commentCount !== commentCount || entry.updatedAt !== updatedAt) {
      return undefined;
    }
    return entry.hasCloseEvidence;
  }

  prune(validTicketIds: ReadonlySet<string>): void {
    for (const ticketId of this.entries.keys()) {
      if (!validTicketIds.has(ticketId)) {
        this.entries.delete(ticketId);
      }
    }
  }
}

interface PrBadgeStatusCacheEntry {
  readonly status: PrStatus | null;
  readonly fetchedAt: number;
  readonly permanent: boolean;
  /**
   * 連続で取得失敗 (rate-limit を除く。not-found/timeout/other) した回数。
   * 否定キャッシュの指数バックオフに使う (bdboard-7ln6 #3)。成功すると 0 に戻る。
   */
  readonly failureStreak: number;
  /**
   * merged/closed だが checks が pending のまま再取得した回数。しきい値
   * (mergedPendingMaxRetries) を超えたら、その時点の状態のまま恒久化する
   * (bdboard-7ln6 #4)。state が merged/closed+pending でなくなると 0 に戻る。
   */
  readonly mergedPendingRetries: number;
}

export interface PrBadgeStatusCacheOptions {
  readonly now?: () => number;
  /** 通常 (open PR 等) の TTL。既定 60秒。 */
  readonly ttlMs?: number;
  /** 否定キャッシュ (失敗) の指数バックオフの上限。既定 30分。 */
  readonly negativeCacheMaxMs?: number;
  /** merged/closed+pending を再取得するまでの TTL。既定 30分。 */
  readonly mergedPendingTtlMs?: number;
  /** merged/closed+pending を何回再取得したら恒久化するか。既定 3回。 */
  readonly mergedPendingMaxRetries?: number;
  /** rate-limit 検知時、最初にサーキットを開く時間。既定 15分。 */
  readonly circuitInitialCooldownMs?: number;
  /** rate-limit が連続したときのサーキット open 時間の上限。既定 1時間。 */
  readonly circuitMaxCooldownMs?: number;
  /** サーキットが open になった瞬間の警告ログ。未指定なら console.warn。 */
  readonly logWarn?: (message: string) => void;
}

const DEFAULT_STATUS_TTL_MS = 60_000;
const DEFAULT_NEGATIVE_CACHE_MAX_MS = 30 * 60_000;
const DEFAULT_MERGED_PENDING_TTL_MS = 30 * 60_000;
const DEFAULT_MERGED_PENDING_MAX_RETRIES = 3;
const DEFAULT_CIRCUIT_INITIAL_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_CIRCUIT_MAX_COOLDOWN_MS = 60 * 60_000;

function isTerminalPrStatus(status: PrStatus | null): boolean {
  if (status === null) {
    return false;
  }
  return (
    (status.state === 'merged' || status.state === 'closed') && status.checkStatus !== 'pending'
  );
}

function isMergedPendingStatus(status: PrStatus): boolean {
  return (status.state === 'merged' || status.state === 'closed') && status.checkStatus === 'pending';
}

/**
 * PR URL ごとの gh pr view 結果を TTL/恒久で保持する薄いキャッシュ。
 *
 * bdboard-7ln6: gh の失敗を握りつぶして60秒TTLでしか覚えないと、rate limit
 * が続く間 board.changed のたびに全PRを撃ち直して rate limit とマシン負荷を
 * 食い潰す。このクラスは (1) rate-limit を検知したら一定時間ぜんぶの gh
 * 起動を止めるサーキットブレーカー、(2) URL単位の失敗の指数バックオフ否定
 * キャッシュ、(3) merged/closed+pending の長め TTL + 最大再試行後の恒久化、
 * (4) 同一 URL への同時リクエストの in-flight 共有、を一手に引き受ける。
 * routes.ts はこれまで通り `new PrBadgeStatusCache()` を引数なしで生成すれば
 * 全部の既定値が効く (routes.ts 無変更で直す方針, bdboard-7ln6 の注意書き)。
 */
export class PrBadgeStatusCache {
  private readonly entries = new Map<string, PrBadgeStatusCacheEntry>();
  private readonly inFlight = new Map<string, Promise<PrStatusResult>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly negativeCacheMaxMs: number;
  private readonly mergedPendingTtlMs: number;
  private readonly mergedPendingMaxRetries: number;
  private readonly circuitInitialCooldownMs: number;
  private readonly circuitMaxCooldownMs: number;
  private readonly logWarn: (message: string) => void;
  private circuitOpenUntil: number | null = null;
  private nextCircuitCooldownMs: number;

  constructor(options?: PrBadgeStatusCacheOptions) {
    this.now = options?.now ?? (() => Date.now());
    this.ttlMs = options?.ttlMs ?? DEFAULT_STATUS_TTL_MS;
    this.negativeCacheMaxMs = options?.negativeCacheMaxMs ?? DEFAULT_NEGATIVE_CACHE_MAX_MS;
    this.mergedPendingTtlMs = options?.mergedPendingTtlMs ?? DEFAULT_MERGED_PENDING_TTL_MS;
    this.mergedPendingMaxRetries =
      options?.mergedPendingMaxRetries ?? DEFAULT_MERGED_PENDING_MAX_RETRIES;
    this.circuitInitialCooldownMs =
      options?.circuitInitialCooldownMs ?? DEFAULT_CIRCUIT_INITIAL_COOLDOWN_MS;
    this.circuitMaxCooldownMs = options?.circuitMaxCooldownMs ?? DEFAULT_CIRCUIT_MAX_COOLDOWN_MS;
    this.logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
    this.nextCircuitCooldownMs = this.circuitInitialCooldownMs;
  }

  get(url: string): PrStatus | null | undefined {
    const entry = this.entries.get(url);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.permanent) {
      return entry.status;
    }
    if (this.now() - entry.fetchedAt < this.computeTtl(entry)) {
      return entry.status;
    }
    // 期限切れでも entries からは消さない — mergedPendingRetries/failureStreak を
    // 失うと「最大N回で恒久化」が二度と成立しなくなる (期限切れのたびにカウンタが
    // 0 に戻ってしまう)。表示に使う値は undefined を返すだけで十分。
    return undefined;
  }

  private computeTtl(entry: PrBadgeStatusCacheEntry): number {
    if (entry.status === null) {
      const backoff = this.ttlMs * 2 ** Math.max(0, entry.failureStreak - 1);
      return Math.min(backoff, this.negativeCacheMaxMs);
    }
    if (isMergedPendingStatus(entry.status)) {
      return this.mergedPendingTtlMs;
    }
    return this.ttlMs;
  }

  /** true の間、fetchStatus は新規に gh を起動しない (bdboard-7ln6 #2)。 */
  isCircuitOpen(): boolean {
    return this.circuitOpenUntil !== null && this.now() < this.circuitOpenUntil;
  }

  isInFlight(url: string): boolean {
    return this.inFlight.has(url);
  }

  /**
   * url の状態取得を行う。同一 url が既に取得中なら新しく gh を起動せず、その
   * Promise を共有する (in-flight 共有, bdboard-7ln6 #6)。取得の起点になった
   * 呼び出しだけが結果を記録する (キャッシュ更新 + サーキットブレーカー判定)。
   * fetcher が例外を投げた場合は記録しない (次回すぐ再試行できるよう、否定
   * キャッシュも書き込まない — 例外時は書き込まない既存契約を維持する)。
   *
   * 呼び出し元は fetchStatus を呼ぶ前に isCircuitOpen() を確認すること — この
   * メソッド自体はサーキット状態を見ない (呼び出し元が起動可否の予算/計測と
   * まとめて判断できるようにするため)。
   */
  fetchStatus(
    url: string,
    fetcher: () => Promise<PrStatusResult>,
  ): { readonly promise: Promise<PrStatusResult>; readonly launched: boolean } {
    const existing = this.inFlight.get(url);
    if (existing !== undefined) {
      return { promise: existing, launched: false };
    }
    const promise = fetcher()
      .then((result) => {
        this.recordResult(url, result);
        return result;
      })
      .finally(() => {
        this.inFlight.delete(url);
      });
    this.inFlight.set(url, promise);
    return { promise, launched: true };
  }

  private recordResult(url: string, result: PrStatusResult): void {
    if (result.status !== null) {
      this.recordSuccess(url, result.status);
      // クールダウン中 (isCircuitOpen()===true) なら閉じない。並行起動された
      // 別URLの成功が、たまたま rate-limit トリップの直後に届いただけかも
      // しれず、それでブレーカーを即リセットしてしまうと再試行間隔の一元管理
      // という目的そのものが壊れる (bdboard-v538)。cooldown が自然に経過した
      // 後の成功 (half-open probe) でのみ閉じ、そこで cooldown 段階もリセット
      // する。
      if (!this.isCircuitOpen()) {
        this.closeCircuit();
      }
      return;
    }
    if (result.reason === 'rate-limit') {
      // URL単位のキャッシュは書かない — サーキットブレーカーが再試行間隔を
      // 一元管理する。ブレーカーが閉じれば、このURLもすぐ再試行対象になる。
      this.tripCircuit();
      return;
    }
    this.recordFailure(url);
  }

  private recordSuccess(url: string, status: PrStatus): void {
    if (isTerminalPrStatus(status)) {
      this.entries.set(url, {
        status,
        fetchedAt: this.now(),
        permanent: true,
        failureStreak: 0,
        mergedPendingRetries: 0,
      });
      return;
    }
    if (isMergedPendingStatus(status)) {
      const previous = this.entries.get(url);
      const retries = (previous?.mergedPendingRetries ?? 0) + 1;
      this.entries.set(url, {
        status,
        fetchedAt: this.now(),
        permanent: retries >= this.mergedPendingMaxRetries,
        failureStreak: 0,
        mergedPendingRetries: retries,
      });
      return;
    }
    this.entries.set(url, {
      status,
      fetchedAt: this.now(),
      permanent: false,
      failureStreak: 0,
      mergedPendingRetries: 0,
    });
  }

  private recordFailure(url: string): void {
    const previous = this.entries.get(url);
    this.entries.set(url, {
      status: null,
      fetchedAt: this.now(),
      permanent: false,
      failureStreak: (previous?.failureStreak ?? 0) + 1,
      mergedPendingRetries: previous?.mergedPendingRetries ?? 0,
    });
  }

  private tripCircuit(): void {
    if (this.isCircuitOpen()) {
      // 既に open (ほぼ同時に走っていた他の URL が先に開いた) — 二重ログ・
      // 二重バックオフを避けるため何もしない。
      return;
    }
    const cooldownMs = this.nextCircuitCooldownMs;
    this.circuitOpenUntil = this.now() + cooldownMs;
    this.nextCircuitCooldownMs = Math.min(cooldownMs * 2, this.circuitMaxCooldownMs);
    this.logWarn(
      `[pr-links] gh reported a rate limit; pausing all gh pr view calls for ${Math.round(
        cooldownMs / 1000,
      )}s.`,
    );
  }

  private closeCircuit(): void {
    this.circuitOpenUntil = null;
    this.nextCircuitCooldownMs = this.circuitInitialCooldownMs;
  }
}

// Matches DEFAULT_CONCURRENCY in bd-cli-issue-repository.ts.
const COMMENT_FETCH_CONCURRENCY = 3;

// 1回の getPrBadges 呼び出しで新規に起動する gh の上限 (bdboard-7ln6 #6)。
// in-flight 共有で乗っかれるものはこの上限を消費しない。
const DEFAULT_MAX_NEW_FETCHES_PER_CALL = 20;

interface CommentFetchItem {
  readonly entry: CachedProject;
  readonly ticket: Ticket;
}

export async function getPrBadges(
  cache: BoardCache,
  commentReader: CommentReader,
  prStatusReader: PrStatusReader,
  options?: GetPrBadgesOptions,
): Promise<readonly PrBadge[]> {
  const projectIdFilter = options?.projectIds;
  const allEntries = cache.listProjects();
  let entries = allEntries;

  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const workItems: CommentFetchItem[] = entries.flatMap((entry) =>
    entry.tickets
      .filter((ticket) => ticket.commentCount > 0)
      .map((ticket) => ({ entry, ticket })),
  );

  const commentCache = options?.commentCache;
  const statusCache = options?.statusCache;
  const maxNewFetchesPerCall = options?.maxNewFetchesPerCall ?? DEFAULT_MAX_NEW_FETCHES_PER_CALL;
  // フィルタ後の workItems ではなく盤面全体 (allEntries) の commentCount>0 集合で
  // pruning する。フィルタ済みの集合を使うと、projectIds でプロジェクトを絞った
  // 呼び出しのたびにフィルタ対象外プロジェクトのキャッシュエントリが間引かれ、
  // 複数プロジェクトを行き来する通常利用でキャッシュが定着しない
  // (bdboard-fwse レビュー指摘)。
  if (commentCache !== undefined) {
    const allTicketIds = new Set(
      allEntries.flatMap((entry) =>
        entry.tickets.filter((ticket) => ticket.commentCount > 0).map((ticket) => ticket.id),
      ),
    );
    commentCache.prune(allTicketIds);
  }

  const badges: PrBadge[] = [];
  // 握り潰しの理由と、1行にまとめる理由は fetch-failure-log.ts を参照 (bdboard-fxxk)。
  const commentFailures: FetchFailure[] = [];
  const statusFailures: FetchFailure[] = [];
  let statusAttempts = 0;
  let newFetchesRemaining = maxNewFetchesPerCall;
  let deferredFetchCount = 0;

  await runWithConcurrencyLimit(workItems, COMMENT_FETCH_CONCURRENCY, async ({ entry, ticket }) => {
    const updatedAtMs = ticket.updatedAt.getTime();
    let url: string | null;
    const cachedUrl = commentCache?.get(ticket.id, ticket.commentCount, updatedAtMs);

    if (cachedUrl !== undefined) {
      url = cachedUrl;
    } else {
      try {
        const comments = await commentReader.listComments(entry.project.rootPath, ticket.id);
        url = extractLatestPrUrl(comments);
        const hasCloseEvidence = comments.some((c) => hasCloseEvidenceMarker(c.text));
        commentCache?.set(ticket.id, ticket.commentCount, updatedAtMs, url, hasCloseEvidence);
      } catch (error) {
        // コメントが読めないチケットは飛ばす。そのチケットのバッジは出ない。
        commentFailures.push({ id: ticket.id, error });
        return;
      }
    }

    if (url === null) {
      return;
    }

    let status: PrBadge['status'] = null;
    const cachedStatus = statusCache?.get(url);

    if (cachedStatus !== undefined) {
      status = cachedStatus;
    } else if (statusCache !== undefined) {
      if (statusCache.isCircuitOpen()) {
        // rate-limit のクールダウン中: gh を1回も起動しない (bdboard-7ln6 #2)。
        status = null;
      } else {
        const alreadyInFlight = statusCache.isInFlight(url);
        if (!alreadyInFlight && newFetchesRemaining <= 0) {
          // 1リクエストあたりの新規起動上限に達した。今回は URL のみのバッジで
          // 妥協し、残りは次回の呼び出し (board.changed のたびに来る) に回す
          // (bdboard-7ln6 #6)。
          deferredFetchCount += 1;
          status = null;
        } else {
          if (!alreadyInFlight) {
            newFetchesRemaining -= 1;
          }
          statusAttempts += 1;
          try {
            const { promise } = statusCache.fetchStatus(url, () => prStatusReader.getPrStatus(url));
            const result = await promise;
            status = result.status;
          } catch (error) {
            // バッジ自体は URL だけで出せるので、状態が引けないのは劣化であって失敗ではない。
            status = null;
            statusFailures.push({ id: url, error });
          }
        }
      }
    } else {
      // statusCache 未指定: 従来通り毎回フェッチする (サーキット/予算/in-flight
      // 共有はキャッシュに紐づく状態なので、キャッシュが無ければ効かせようがない)。
      statusAttempts += 1;
      try {
        const result = await prStatusReader.getPrStatus(url);
        status = result.status;
      } catch (error) {
        status = null;
        statusFailures.push({ id: url, error });
      }
    }

    badges.push({
      ticketId: ticket.id,
      projectId: entry.project.id,
      url,
      status,
    });
  });

  const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
  if (commentFailures.length > 0) {
    logWarn(
      '[pr-links] could not load comments for some tickets; their PR badges are missing. ' +
        describeFetchFailures(commentFailures, workItems.length),
    );
  }
  if (statusFailures.length > 0) {
    logWarn(
      '[pr-links] could not load PR status for some links; those badges show no status. ' +
        describeFetchFailures(statusFailures, statusAttempts),
    );
  }
  if (deferredFetchCount > 0) {
    logWarn(
      `[pr-links] deferred ${deferredFetchCount} PR status fetch(es) to a later refresh ` +
        `(reached the limit of ${maxNewFetchesPerCall} new gh launches for this request).`,
    );
  }

  badges.sort((a, b) => {
    const projectDiff = compareStrings(a.projectId, b.projectId);
    if (projectDiff !== 0) {
      return projectDiff;
    }
    return compareStrings(a.ticketId, b.ticketId);
  });

  return badges;
}
