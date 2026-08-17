import type { LeftoverCandidate } from '../../domain/git-worktree.js';
import { checkHygiene, type HygieneIssue } from '../../domain/hygiene.js';
import type { BoardCache } from '../ports/board-cache.js';

export interface GetHygieneIssuesOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
  readonly leftoverCandidates?: readonly LeftoverCandidate[];
}

export function getHygieneIssues(
  cache: BoardCache,
  now: Date,
  options?: GetHygieneIssuesOptions,
): readonly HygieneIssue[] {
  const projectIdFilter = options?.projectIds;
  let entries = cache.listProjects();

  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const tickets = entries.flatMap((entry) => entry.tickets);
  return checkHygiene(tickets, {
    now,
    ...(options?.leftoverCandidates !== undefined
      ? { leftoverCandidates: options.leftoverCandidates }
      : {}),
  });
}
