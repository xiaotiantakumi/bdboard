import { compareStrings } from '../../domain/compare.js';
import { extractLatestPrUrl, type PrBadge } from '../../domain/pr-link.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import type { CommentReader } from '../ports/comment-reader.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';
import type { Ticket } from '../../domain/ticket.js';

export interface GetPrBadgesOptions {
  readonly projectIds?: readonly string[];
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

  await runWithConcurrencyLimit(workItems, COMMENT_FETCH_CONCURRENCY, async ({ entry, ticket }) => {
    try {
      const comments = await commentReader.listComments(entry.project.rootPath, ticket.id);
      const url = extractLatestPrUrl(comments);
      if (url === null) {
        return;
      }

      let status: PrBadge['status'] = null;
      try {
        status = await prStatusReader.getPrStatus(url);
      } catch {
        status = null;
      }

      badges.push({
        ticketId: ticket.id,
        projectId: entry.project.id,
        url,
        status,
      });
    } catch {
      // Skip tickets whose comments cannot be loaded.
    }
  });

  badges.sort((a, b) => {
    const projectDiff = compareStrings(a.projectId, b.projectId);
    if (projectDiff !== 0) {
      return projectDiff;
    }
    return compareStrings(a.ticketId, b.ticketId);
  });

  return badges;
}
