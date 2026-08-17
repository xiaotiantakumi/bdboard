import { compareStrings } from '../../domain/compare.js';
import { extractLatestPrUrl, type PrBadge } from '../../domain/pr-link.js';
import type { BoardCache } from '../ports/board-cache.js';
import type { CommentReader } from '../ports/comment-reader.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';

export interface GetPrBadgesOptions {
  readonly projectIds?: readonly string[];
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

  const settled = await Promise.allSettled(
    entries.flatMap((entry) =>
      entry.tickets
        .filter((ticket) => ticket.commentCount > 0)
        .map(async (ticket) => {
          try {
            const comments = await commentReader.listComments(
              entry.project.rootPath,
              ticket.id,
            );
            const url = extractLatestPrUrl(comments);
            if (url === null) {
              return null;
            }

            let status: PrBadge['status'] = null;
            try {
              status = await prStatusReader.getPrStatus(url);
            } catch {
              status = null;
            }

            return {
              ticketId: ticket.id,
              projectId: entry.project.id,
              url,
              status,
            };
          } catch {
            return null;
          }
        }),
    ),
  );

  const badges: PrBadge[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled' && outcome.value !== null) {
      badges.push(outcome.value);
    }
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
