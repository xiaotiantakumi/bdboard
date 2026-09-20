import { compareStrings } from '../compare.js';
import type { ReadinessContext } from '../readiness.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';

export function buildBlocksIndex(
  tickets: readonly Ticket[],
): Map<TicketId, TicketId[]> {
  const index = new Map<TicketId, TicketId[]>();

  for (const ticket of tickets) {
    for (const edge of ticket.dependencies) {
      if (edge.kind !== 'blocks') {
        continue;
      }

      let successors = index.get(edge.dependsOnId);
      if (successors === undefined) {
        successors = [];
        index.set(edge.dependsOnId, successors);
      }
      successors.push(edge.issueId);
    }
  }

  return index;
}

export function deriveBlocks(
  ticketId: TicketId,
  blocksIndex: Map<TicketId, TicketId[]>,
  ctx: ReadinessContext,
): readonly TicketId[] {
  const candidates = blocksIndex.get(ticketId) ?? [];
  const seen = new Set<TicketId>();
  const blocks: TicketId[] = [];

  for (const issueId of candidates) {
    const status = ctx.statusOf(issueId);
    if (status === undefined || status === 'closed') {
      continue;
    }

    if (!seen.has(issueId)) {
      seen.add(issueId);
      blocks.push(issueId);
    }
  }

  return blocks.sort(compareStrings);
}
