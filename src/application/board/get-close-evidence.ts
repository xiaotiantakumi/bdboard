import { needsCloseEvidenceLookup, pendingDecisionKey } from '../../domain/hygiene.js';
import type { Ticket } from '../../domain/ticket.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import type { CommentReader } from '../ports/comment-reader.js';
import { describeFetchFailures, type FetchFailure } from './fetch-failure-log.js';

interface CloseEvidenceCacheEntry {
  readonly commentCount: number;
  readonly updatedAt: number;
  readonly hasEvidence: boolean;
  readonly storedAtMs: number;
}

/**
 * 新規フェッチのバッチを始めてよい最短間隔。
 *
 * useBoardStream が board 更新のたびに ['hygiene'] を invalidate するので、
 * 健全性パネルを開いたままだと **他セッションが bd に書き込むたび** に
 * ウォームアップのバッチが走る。bd は single writer なので、それは常時稼働の
 * bd を食い続けることを意味する。1バッチ = 最大 CLOSE_EVIDENCE_FETCH_BUDGET_MS
 * なので、15秒に1バッチなら bd の占有は最悪でも 2.5/15 ≒ 17% に収まる。
 * ウォーム完了に必要なのは実測で 15〜20 バッチなので、上限でも数分で温まる。
 */
export const CLOSE_EVIDENCE_FETCH_MIN_INTERVAL_MS = 15_000;

/**
 * 「証拠なし」と判定した結果だけを保持する時間。
 *
 * bd の updated_at はコメントの追加・編集で動かないので、無効化に使えるのは
 * 実質 commentCount だけ。既存コメントを編集して PR: を足しても件数は変わらず、
 * 否定の結果を無期限にキャッシュすると警告がサーバ再起動まで消えない。
 * 肯定 (証拠あり) は消えないので TTL を付けない (PrBadgeStatusCache が
 * terminal な状態だけ permanent にしているのと同じ考え方)。
 */
export const CLOSE_EVIDENCE_NEGATIVE_TTL_MS = 5 * 60_000;

/** チケットごとの「コメントに PR:/検証: があるか」を commentCount/updatedAt で無効化する薄いキャッシュ。 */
export class CloseEvidenceCache {
  private readonly entries = new Map<string, CloseEvidenceCacheEntry>();
  /**
   * ウォームアップのバースト間隔ガード (M3)。プロセス内で1インスタンスだけ持つ。
   */
  private lastFetchBatchStartedAtMs: number | undefined;
  private readonly negativeTtlMs: number;

  constructor(options?: { readonly negativeTtlMs?: number }) {
    this.negativeTtlMs = options?.negativeTtlMs ?? CLOSE_EVIDENCE_NEGATIVE_TTL_MS;
  }

  get(
    ticketId: string,
    commentCount: number,
    updatedAt: number,
    nowMs: number,
  ): boolean | undefined {
    const entry = this.entries.get(ticketId);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.commentCount !== commentCount || entry.updatedAt !== updatedAt) {
      return undefined;
    }
    if (entry.hasEvidence === false && nowMs - entry.storedAtMs >= this.negativeTtlMs) {
      this.entries.delete(ticketId);
      return undefined;
    }
    return entry.hasEvidence;
  }

  set(
    ticketId: string,
    commentCount: number,
    updatedAt: number,
    hasEvidence: boolean,
    storedAtMs: number,
  ): void {
    this.entries.set(ticketId, { commentCount, updatedAt, hasEvidence, storedAtMs });
  }

  /** 前回バッチから minIntervalMs 以上経っていれば true を返し、開始時刻を記録する。 */
  tryStartFetchBatch(nowMs: number, minIntervalMs: number): boolean {
    if (
      this.lastFetchBatchStartedAtMs !== undefined &&
      nowMs - this.lastFetchBatchStartedAtMs < minIntervalMs
    ) {
      return false;
    }
    this.lastFetchBatchStartedAtMs = nowMs;
    return true;
  }

  prune(validTicketIds: ReadonlySet<string>): void {
    for (const ticketId of this.entries.keys()) {
      if (!validTicketIds.has(ticketId)) {
        this.entries.delete(ticketId);
      }
    }
  }
}

export interface CloseEvidence {
  /** コメントに PR:/検証: があると確認できたチケット。 */
  readonly evidenceKeys: ReadonlySet<string>;
  /** 今回のリクエストでは確認しきれなかったチケット（未確認）。 */
  readonly unknownKeys: ReadonlySet<string>;
}

export interface GetCloseEvidenceOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
  /** 取得失敗の警告ログ。未指定なら console.warn (discover-projects と同じ注入流儀)。 */
  readonly logWarn?: (message: string) => void;
  readonly cache?: CloseEvidenceCache;
  /** 1リクエストで新規に bd を叩き続ける時間上限 (ms)。既定 CLOSE_EVIDENCE_FETCH_BUDGET_MS。 */
  readonly fetchBudgetMs?: number;
  /** 新規フェッチバッチの最短間隔 (ms)。既定 CLOSE_EVIDENCE_FETCH_MIN_INTERVAL_MS。cache 未指定時は無視。 */
  readonly minFetchIntervalMs?: number;
  /** 締め切り判定に使う時刻源。テスト用。未指定なら performance.now() (壁時計は NTP 巻き戻しで締め切りが永久成立しうる)。 */
  readonly monotonicNow?: () => number;
}

// get-pending-comment-anchors.ts / get-pr-badges.ts と同じ。bd-cli-issue-repository.ts の DEFAULT_CONCURRENCY に合わせる。
const COMMENT_FETCH_CONCURRENCY = 3;

/**
 * 1リクエストで新規に bd comments を叩き続ける時間の上限。
 *
 * bd comments は1件 0.8〜4s とばらつく (bd は single writer で、常時稼働サーバーや
 * 他セッションと奪い合うため)。実測では **件数で切ってもリクエスト時間はバウンド
 * できなかった** — 3件でも 11.8s かかることがあり、2.3s で終わることもある。
 * バウンドしたいのは件数ではなくリクエスト時間なので、締め切りで切る。
 * 速いときは多く温まり、遅いときは早く切り上がる。
 *
 * 締め切りを過ぎた時点で新規フェッチをやめるだけなので、実際の上振れは
 * 「締め切り + 実行中の1件が終わるまで」。2.5s なら最悪でも数秒の上乗せに収まり、
 * ベースライン (5.4〜13.6s) を大きく崩さない。溢れたぶんは unknownKeys として返り、
 * 次のリクエストで少しずつ温まる。
 */
export const CLOSE_EVIDENCE_FETCH_BUDGET_MS = 2_500;

interface FetchItem {
  readonly entry: CachedProject;
  readonly ticket: Ticket;
}

function commentHasCloseEvidence(text: string): boolean {
  if (text.includes('PR:') || text.includes('PR：')) {
    return true;
  }
  if (text.includes('検証:') || text.includes('検証：')) {
    return true;
  }
  return false;
}

/**
 * close 済みチケットのコメントから PR/検証の記録があるかを返す (bdboard-pkr6.8)。
 *
 * bd comments は issue-id 必須で1チケットずつプロセスを起動するしかなく、
 * 182件を並列度3で舐めると実測 510秒規模になる。embedded Dolt は single writer
 * なので並列度を上げても実時間は縮まない。
 *
 * 対象はドメインの needsCloseEvidenceLookup() で絞る (closeReason に証拠がある
 * 74件は bd を叩かない)。残りも1リクエストあたり CLOSE_EVIDENCE_FETCH_BUDGET_MS
 * の時間内だけ新規フェッチし、溢れは unknownKeys として hygiene 側に返す — 未確認は
 * closed_without_evidence として出さない。
 *
 * **コメント本文は返り値にキャッシュしない。** 真偽値だけを CloseEvidenceCache に
 * 保持し、commentCount/updatedAt が変われば無効化する (PrBadgeCommentCache と同じ
 * 設計)。キー集合だけに潰すのは、refresh ごとに本文を持ち回るとメモリと転送量が
 * 膨らむため (get-pending-comment-anchors が Date だけを返すのと同じ)。
 *
 * フェッチ失敗は unknownKeys に入れ、誤検知は出さない。呼び出し1回につき1行だけ
 * 警告を出す (bdboard-fxxk)。
 */
export async function getCloseEvidence(
  cache: BoardCache,
  commentReader: CommentReader,
  now: Date,
  windowMs: number,
  options?: GetCloseEvidenceOptions,
): Promise<CloseEvidence> {
  const projectIdFilter = options?.projectIds;
  const allEntries = cache.listProjects();
  let entries = allEntries;

  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const evidenceCache = options?.cache;
  // フィルタ後の entries ではなく盤面全体 (allEntries) の ticket 集合で pruning する。
  // フィルタ済みの集合を使うと、projectIds でプロジェクトを絞った呼び出しのたびに
  // フィルタ対象外プロジェクトのキャッシュエントリが間引かれ、複数プロジェクトを
  // 行き来する通常利用でキャッシュが定着しない (get-pr-badges.ts / bdboard-fwse)。
  if (evidenceCache !== undefined) {
    const allTicketIds = new Set(
      allEntries.flatMap((entry) => entry.tickets.map((ticket) => ticket.id)),
    );
    evidenceCache.prune(allTicketIds);
  }

  const items: FetchItem[] = entries.flatMap((entry) =>
    entry.tickets
      .filter((ticket) => needsCloseEvidenceLookup(ticket, now, windowMs))
      .map((ticket) => ({ entry, ticket })),
  );

  const evidenceKeys = new Set<string>();
  const unknownKeys = new Set<string>();
  const fetchCandidates: FetchItem[] = [];
  const fetchBudgetMs = options?.fetchBudgetMs ?? CLOSE_EVIDENCE_FETCH_BUDGET_MS;
  const monotonicNow = options?.monotonicNow ?? (() => performance.now());

  // 1リクエストの中では TTL 判定の基準時刻を1つに固定する。チケットごとに
  // 取り直すと、同じリクエストなのに前半と後半で期限判定がずれる。
  const lookupNowMs = monotonicNow();

  for (const item of items) {
    const { entry, ticket } = item;
    const updatedAtMs = ticket.updatedAt.getTime();
    const cached = evidenceCache?.get(ticket.id, ticket.commentCount, updatedAtMs, lookupNowMs);

    if (cached === true) {
      evidenceKeys.add(pendingDecisionKey(entry.project.id, ticket.id));
    } else if (cached === false) {
      // 証拠なし確定。bd を起動しない。
    } else {
      fetchCandidates.push(item);
    }
  }

  fetchCandidates.sort(
    (a, b) => b.ticket.closedAt!.getTime() - a.ticket.closedAt!.getTime(),
  );

  let itemsToFetch = fetchCandidates;
  if (fetchCandidates.length > 0 && evidenceCache !== undefined) {
    const minIntervalMs =
      options?.minFetchIntervalMs ?? CLOSE_EVIDENCE_FETCH_MIN_INTERVAL_MS;
    if (!evidenceCache.tryStartFetchBatch(monotonicNow(), minIntervalMs)) {
      for (const { entry, ticket } of fetchCandidates) {
        unknownKeys.add(pendingDecisionKey(entry.project.id, ticket.id));
      }
      itemsToFetch = [];
    }
  }

  const deadline = monotonicNow() + fetchBudgetMs;
  const failures: FetchFailure[] = [];
  let fetchAttempts = 0;

  await runWithConcurrencyLimit(itemsToFetch, COMMENT_FETCH_CONCURRENCY, async ({ entry, ticket }) => {
    const key = pendingDecisionKey(entry.project.id, ticket.id);
    if (monotonicNow() >= deadline) {
      unknownKeys.add(key);
      return;
    }

    fetchAttempts += 1;
    const updatedAtMs = ticket.updatedAt.getTime();
    let comments;
    try {
      comments = await commentReader.listComments(entry.project.rootPath, ticket.id);
    } catch (error) {
      failures.push({ id: ticket.id, error });
      unknownKeys.add(key);
      return;
    }

    let hasEvidence = false;
    for (const comment of comments) {
      if (commentHasCloseEvidence(comment.text)) {
        hasEvidence = true;
        break;
      }
    }

    const storedAtMs = monotonicNow();
    evidenceCache?.set(ticket.id, ticket.commentCount, updatedAtMs, hasEvidence, storedAtMs);
    if (hasEvidence) {
      evidenceKeys.add(key);
    }
  });

  if (failures.length > 0) {
    const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
    logWarn(
      '[close-evidence] could not load comments for some recently closed tickets; ' +
        'they are treated as unknown (not flagged as closed_without_evidence) until ' +
        'a later request confirms them. ' +
        describeFetchFailures(failures, fetchAttempts),
    );
  }

  if (unknownKeys.size > 0) {
    const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
    logWarn(
      `[close-evidence] ${unknownKeys.size} of ${items.length} recently closed tickets are still unchecked; ` +
        'closed_without_evidence may be under-reported until a later request confirms them.',
    );
  }

  return { evidenceKeys, unknownKeys };
}
