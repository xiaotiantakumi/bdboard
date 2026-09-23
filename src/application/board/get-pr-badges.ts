import { compareStrings } from '../../domain/compare.js';
import { extractLatestPrUrl, type PrBadge, type PrStatus } from '../../domain/pr-link.js';
import { hasCloseEvidenceMarker } from './close-evidence-marker.js';
import { Semaphore } from '../concurrency.js';
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
  /**
   * PR ステータス取得 (gh pr view 起動) 専用の並列数。コメント取得 (bd 経由・ローカル)
   * とは独立した上限を持つ (bdboard-se3v)。以前はコメント取得とステータス取得が同じ
   * worker 内で直列に実行され、事実上ステータス取得もコメント取得と同じ並列数
   * (COMMENT_FETCH_CONCURRENCY=3) でしか起動できなかった。gh はネットワーク越しの
   * プロセス起動でボトルネックの本体なので、ここだけ高い並列数を持たせて短縮する
   * (際限なく並列にはしない —— 上限は残す)。未指定なら DEFAULT_STATUS_FETCH_CONCURRENCY。
   */
  readonly statusFetchConcurrency?: number;
  /**
   * この呼び出し全体 (コメント解決 + ステータス取得) の時間予算 (ms)。超過した時点で、
   * その時点までに分かっている分だけを返す (未解決分は status:null のまま —— 既存の
   * 「取得できていない」という意味を変えずに使い回す。bdboard-se3v)。超過後も内部の
   * 取得処理はキャンセルせず裏で走らせ続け、各キャッシュ (commentCache/statusCache) を
   * 温めて次回の呼び出しに備える。未指定ならタイムアウトなし (完了まで待つ、従来通り)。
   */
  readonly overallTimeoutMs?: number;
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

// gh pr view (ステータス取得) 専用の既定並列数。GetPrBadgesOptions.statusFetchConcurrency
// の説明を参照 (bdboard-se3v)。
const DEFAULT_STATUS_FETCH_CONCURRENCY = 8;

interface CommentFetchItem {
  readonly entry: CachedProject;
  readonly ticket: Ticket;
}

export interface PrStatusBudget {
  remaining: number;
}

export interface ResolvePrStatusDeps {
  readonly prStatusReader: PrStatusReader;
  readonly statusCache?: PrBadgeStatusCache;
  readonly budget: PrStatusBudget;
  /** 1リクエストあたりの新規起動上限に達し、今回は見送った (bdboard-7ln6 #6)。 */
  readonly onDeferred: () => void;
  /** gh を実際に起動しに行った (cache/circuit/budget いずれもすり抜けた)。 */
  readonly onAttempt: () => void;
  /** gh 起動が失敗した (バッジ自体は URL だけで出せるので劣化として扱う)。 */
  readonly onFailure: (error: unknown) => void;
}

export async function resolvePrStatus(
  url: string,
  deps: ResolvePrStatusDeps,
): Promise<PrBadge['status']> {
  const { prStatusReader, statusCache, budget, onDeferred, onAttempt, onFailure } = deps;
  const cachedStatus = statusCache?.get(url);

  if (cachedStatus !== undefined) {
    return cachedStatus;
  }

  if (statusCache === undefined) {
    // statusCache 未指定: 従来通り毎回フェッチする (サーキット/予算/in-flight
    // 共有はキャッシュに紐づく状態なので、キャッシュが無ければ効かせようがない)。
    onAttempt();
    try {
      const result = await prStatusReader.getPrStatus(url);
      return result.status;
    } catch (error) {
      onFailure(error);
      return null;
    }
  }

  if (statusCache.isCircuitOpen()) {
    // rate-limit のクールダウン中: gh を1回も起動しない (bdboard-7ln6 #2)。
    return null;
  }

  const alreadyInFlight = statusCache.isInFlight(url);
  if (!alreadyInFlight && budget.remaining <= 0) {
    // 1リクエストあたりの新規起動上限に達した。今回は URL のみのバッジで妥協し、
    // 残りは次回の呼び出し (board.changed のたびに来る) に回す (bdboard-7ln6 #6)。
    onDeferred();
    return null;
  }

  if (!alreadyInFlight) {
    budget.remaining -= 1;
  }
  onAttempt();
  try {
    const { promise } = statusCache.fetchStatus(url, () => prStatusReader.getPrStatus(url));
    const result = await promise;
    return result.status;
  } catch (error) {
    // バッジ自体は URL だけで出せるので、状態が引けないのは劣化であって失敗ではない。
    onFailure(error);
    return null;
  }
}

export async function raceWithOverallTimeout(
  mainWork: Promise<void>,
  overallTimeoutMs: number,
): Promise<boolean> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutSignal = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, overallTimeoutMs);
  });
  await Promise.race([mainWork, timeoutSignal]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return timedOut;
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
  const statusFetchConcurrency =
    options?.statusFetchConcurrency ?? DEFAULT_STATUS_FETCH_CONCURRENCY;
  const overallTimeoutMs = options?.overallTimeoutMs;
  const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));

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

  // ticketId をキーにする (配列 push ではなく) —— URL 解決が終わった時点で status:null の
  // プレースホルダを入れ、ステータス解決が完了したら上書きする。全体タイムアウトで早期に
  // 打ち切っても、この Map をそのままスナップショットすれば「PR は分かっているがステータス
  // 未取得」を素直に表現できる (status:null は元々失敗/rate-limit/予算切れでも使っていた
  // 値であり、意味は変えない)。
  const badgesByTicket = new Map<string, PrBadge>();
  // 握り潰しの理由と、1行にまとめる理由は fetch-failure-log.ts を参照 (bdboard-fxxk)。
  const commentFailures: FetchFailure[] = [];
  const statusFailures: FetchFailure[] = [];
  let statusAttempts = 0;
  const statusBudget: PrStatusBudget = { remaining: maxNewFetchesPerCall };
  let deferredFetchCount = 0;
  const commentGate = new Semaphore(COMMENT_FETCH_CONCURRENCY);
  const statusGate = new Semaphore(statusFetchConcurrency);

  const logCompletionWarnings = (): void => {
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
  };

  // 1チケットぶんの処理単位: URL 解決 (bd 経由) → 分かればステータス解決 (gh 経由) を
  // 直列に行うが、どちらも専用のセマフォで別々に同時実行数を絞るだけで、全チケットの
  // worker 自体は最初から並行に起動する (bdboard-se3v)。以前は「全チケットのURL解決
  // (Pass 1) が終わってから全チケットのステータス解決 (Pass 2) を始める」という2段
  // 構成だったが、実データで計測すると Pass 1 (bd 経由のコメント走査、
  // COMMENT_FETCH_CONCURRENCY=3 で有界) だけで overallTimeoutMs を使い切ってしまい、
  // gh が1件も起動できないまま毎回タイムアウトするケースが確認できた
  // (ボード全体のチケット数が多いと bd 側の走査だけで数秒かかるため)。commentGate/
  // statusGate それぞれの acquire は実際に処理を投げる直前に行われるので、サーキット
  // ブレーカーやキャッシュの状態は dispatch のたびに再評価される (トリップ直後に
  // 投げられる分だけを確実に止められる、という従来の性質を維持する)。
  const runTicket = async ({ entry, ticket }: CommentFetchItem): Promise<void> => {
    const updatedAtMs = ticket.updatedAt.getTime();
    const cachedUrl = commentCache?.get(ticket.id, ticket.commentCount, updatedAtMs);
    let url: string | null;

    if (cachedUrl !== undefined) {
      // キャッシュヒットは実際の bd 呼び出しが無いので commentGate を消費しない
      // (以前は Pass 1 全体が1本の runWithConcurrencyLimit だったため、キャッシュ
      // ヒットでも並列枠を1つ使っていた —— 使わない方が正しい)。
      url = cachedUrl;
    } else {
      await commentGate.acquire();
      try {
        const comments = await commentReader.listComments(entry.project.rootPath, ticket.id);
        url = extractLatestPrUrl(comments);
        const hasCloseEvidence = comments.some((c) => hasCloseEvidenceMarker(c.text));
        commentCache?.set(ticket.id, ticket.commentCount, updatedAtMs, url, hasCloseEvidence);
      } catch (error) {
        // コメントが読めないチケットは飛ばす。そのチケットのバッジは出ない。
        commentFailures.push({ id: ticket.id, error });
        return;
      } finally {
        commentGate.release();
      }
    }

    if (url === null) {
      return;
    }

    badgesByTicket.set(ticket.id, {
      ticketId: ticket.id,
      projectId: entry.project.id,
      url,
      status: null,
    });

    await statusGate.acquire();
    try {
      const status = await resolvePrStatus(url, {
        prStatusReader,
        statusCache,
        budget: statusBudget,
        onDeferred: () => {
          deferredFetchCount += 1;
        },
        onAttempt: () => {
          statusAttempts += 1;
        },
        onFailure: (error) => {
          statusFailures.push({ id: url, error });
        },
      });
      badgesByTicket.set(ticket.id, {
        ticketId: ticket.id,
        projectId: entry.project.id,
        url,
        status,
      });
    } finally {
      statusGate.release();
    }
  };

  const mainWork = Promise.all(workItems.map(runTicket)).then(() => undefined);

  let timedOut = false;
  if (overallTimeoutMs !== undefined) {
    timedOut = await raceWithOverallTimeout(mainWork, overallTimeoutMs);
  } else {
    await mainWork;
  }

  const snapshotBadges = (): PrBadge[] => {
    const badges = [...badgesByTicket.values()];
    badges.sort((a, b) => {
      const projectDiff = compareStrings(a.projectId, b.projectId);
      if (projectDiff !== 0) {
        return projectDiff;
      }
      return compareStrings(a.ticketId, b.ticketId);
    });
    return badges;
  };

  if (timedOut) {
    const partial = snapshotBadges();
    const stillUnresolved = partial.filter((badge) => badge.status === null).length;
    logWarn(
      `[pr-links] overall time budget of ${overallTimeoutMs}ms exceeded; returning ` +
        `${partial.length} badge(s) so far (${stillUnresolved} without a resolved status yet). ` +
        'The remaining comment/status lookups keep running in the background and will warm ' +
        'the cache for the next refresh.',
    );
    // mainWork は止めない (キャッシュを温め続けさせる)。この応答はもう使わないので、
    // 完了時の失敗ログだけ後追いで出す。想定外の reject に備えて拾っておく。
    mainWork.then(logCompletionWarnings, (error: unknown) => {
      logWarn(
        `[pr-links] background continuation after timeout failed unexpectedly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return partial;
  }

  logCompletionWarnings();
  return snapshotBadges();
}
