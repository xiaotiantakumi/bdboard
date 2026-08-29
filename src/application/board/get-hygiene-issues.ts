import type { LeftoverCandidate } from '../../domain/git-worktree.js';
import { checkHygiene, type HygieneIssue } from '../../domain/hygiene.js';
import type { TicketId } from '../../domain/ticket-id.js';
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

  // 確認待ちレーンは bd の human ラベル由来で、refreshProjects がキャッシュに
  // 載せた pendingDecisions がその原本 (get-board.ts の humanLabeledIdsFromCache と
  // 同じ出所)。ドメイン側は Ticket しか見ないので、ここで集めて渡す。
  const pendingDecisionIds = new Set<TicketId>(
    entries.flatMap((entry) =>
      (entry.pendingDecisions ?? []).map((decision) => decision.id),
    ),
  );

  return checkHygiene(tickets, {
    now,
    pendingDecisionIds,
    ...(options?.leftoverCandidates !== undefined
      ? { leftoverCandidates: options.leftoverCandidates }
      : {}),
  });
}
