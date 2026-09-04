import { compareStrings } from '../../domain/compare.js';
import { extractLatestPrUrl, type PrBadge, type PrStatus } from '../../domain/pr-link.js';
import { hasCloseEvidenceMarker } from './close-evidence-marker.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import type { CommentReader } from '../ports/comment-reader.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';
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
}

export interface PrBadgeStatusCacheOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
}

const DEFAULT_STATUS_TTL_MS = 60_000;

function isTerminalPrStatus(status: PrStatus | null): boolean {
  if (status === null) {
    return false;
  }
  return (
    (status.state === 'merged' || status.state === 'closed') && status.checkStatus !== 'pending'
  );
}

/** PR URL ごとの gh pr view 結果を TTL/恒久で保持する薄いキャッシュ。 */
export class PrBadgeStatusCache {
  private readonly entries = new Map<string, PrBadgeStatusCacheEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options?: PrBadgeStatusCacheOptions) {
    this.now = options?.now ?? (() => Date.now());
    this.ttlMs = options?.ttlMs ?? DEFAULT_STATUS_TTL_MS;
  }

  get(url: string): PrStatus | null | undefined {
    const entry = this.entries.get(url);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.permanent) {
      return entry.status;
    }
    if (this.now() - entry.fetchedAt < this.ttlMs) {
      return entry.status;
    }
    this.entries.delete(url);
    return undefined;
  }

  set(url: string, status: PrStatus | null): void {
    this.entries.set(url, {
      status,
      fetchedAt: this.now(),
      permanent: isTerminalPrStatus(status),
    });
  }
}

// Matches DEFAULT_CONCURRENCY in bd-cli-issue-repository.ts.
const COMMENT_FETCH_CONCURRENCY = 3;

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
    } else {
      statusAttempts += 1;
      try {
        status = await prStatusReader.getPrStatus(url);
        statusCache?.set(url, status);
      } catch (error) {
        // バッジ自体は URL だけで出せるので、状態が引けないのは劣化であって失敗ではない。
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

  badges.sort((a, b) => {
    const projectDiff = compareStrings(a.projectId, b.projectId);
    if (projectDiff !== 0) {
      return projectDiff;
    }
    return compareStrings(a.ticketId, b.ticketId);
  });

  return badges;
}
