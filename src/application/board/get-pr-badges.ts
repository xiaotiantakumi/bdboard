import { compareStrings } from '../../domain/compare.js';
import { extractLatestPrUrl, type PrBadge } from '../../domain/pr-link.js';
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
  let entries = cache.listProjects();

  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const workItems: CommentFetchItem[] = entries.flatMap((entry) =>
    entry.tickets
      .filter((ticket) => ticket.commentCount > 0)
      .map((ticket) => ({ entry, ticket })),
  );

  const badges: PrBadge[] = [];
  // 握り潰しの理由と、1行にまとめる理由は fetch-failure-log.ts を参照 (bdboard-fxxk)。
  const commentFailures: FetchFailure[] = [];
  const statusFailures: FetchFailure[] = [];
  let statusAttempts = 0;

  await runWithConcurrencyLimit(workItems, COMMENT_FETCH_CONCURRENCY, async ({ entry, ticket }) => {
    try {
      const comments = await commentReader.listComments(entry.project.rootPath, ticket.id);
      const url = extractLatestPrUrl(comments);
      if (url === null) {
        return;
      }

      let status: PrBadge['status'] = null;
      statusAttempts += 1;
      try {
        status = await prStatusReader.getPrStatus(url);
      } catch (error) {
        // バッジ自体は URL だけで出せるので、状態が引けないのは劣化であって失敗ではない。
        status = null;
        statusFailures.push({ id: url, error });
      }

      badges.push({
        ticketId: ticket.id,
        projectId: entry.project.id,
        url,
        status,
      });
    } catch (error) {
      // コメントが読めないチケットは飛ばす。そのチケットのバッジは出ない。
      commentFailures.push({ id: ticket.id, error });
    }
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
