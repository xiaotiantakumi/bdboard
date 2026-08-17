import { buildDirectChildrenIndex } from './epic-progress.js';
import type { Ticket } from './ticket.js';
import type { TicketId } from './ticket-id.js';

export function collectEpicDescendantIds(
  epicId: TicketId,
  childrenIndex: ReadonlyMap<TicketId, readonly TicketId[]>,
): Set<TicketId> {
  const descendants = new Set<TicketId>();
  const pending = [...(childrenIndex.get(epicId) ?? [])];

  while (pending.length > 0) {
    const childId = pending.shift();
    if (childId === undefined || descendants.has(childId)) {
      continue;
    }
    descendants.add(childId);
    pending.push(...(childrenIndex.get(childId) ?? []));
  }

  return descendants;
}

export function filterTicketsByEpic(
  epicId: TicketId,
  tickets: readonly Ticket[],
): Ticket[] {
  const childrenIndex = buildDirectChildrenIndex(tickets);
  const descendantIds = collectEpicDescendantIds(epicId, childrenIndex);
  return tickets.filter((ticket) => ticket.id === epicId || descendantIds.has(ticket.id));
}
