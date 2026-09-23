import { compareStrings } from '../compare.js';
import type { LeftoverCandidate } from '../git-worktree.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';
import { entryKey } from './types.js';

/** 変更ファイルを取りに行くべき worktree。「closed でない × worktree がある」 */
export interface InFlightWorktree {
  readonly projectId: string;
  readonly ticketId: TicketId;
  readonly worktreePath: string;
}

/**
 * leftover 候補 (merged_leftover と同じ worktree 一覧) から、着手中ぶんだけ選ぶ。
 *
 * merged_leftover が「closed なのに worktree が残っている」を見るのに対して、こちらは
 * その補集合 = 「まだ closed でないチケットの worktree」を見る。両者で同じ
 * collectLeftoverCandidates の結果を使い回すので、git worktree list は 1 回で済む。
 *
 * deferred や blocked も含める。ステータスが何であれ worktree にファイルが積まれて
 * いる以上、後から rebase で衝突する事実は変わらない。
 */
export function selectInFlightWorktrees(
  candidates: readonly LeftoverCandidate[],
  tickets: readonly Ticket[],
): readonly InFlightWorktree[] {
  const ticketByKey = new Map<string, Ticket>(
    tickets.map((ticket) => [entryKey(ticket.projectId, ticket.id), ticket] as const),
  );

  const selected: InFlightWorktree[] = [];

  for (const candidate of candidates) {
    if (candidate.worktreePath === null) {
      continue;
    }
    const ticket = ticketByKey.get(entryKey(candidate.projectId, candidate.ticketId));
    if (ticket === undefined) {
      continue;
    }
    if (ticket.status === 'closed') {
      continue;
    }

    selected.push({
      projectId: candidate.projectId,
      ticketId: candidate.ticketId,
      worktreePath: candidate.worktreePath,
    });
  }

  return selected.sort((a, b) => {
    const projectDiff = compareStrings(a.projectId, b.projectId);
    return projectDiff !== 0 ? projectDiff : compareStrings(a.ticketId, b.ticketId);
  });
}
