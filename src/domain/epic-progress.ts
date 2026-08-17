import type { Ticket } from './ticket.js';
import type { TicketId } from './ticket-id.js';

export interface EpicProgress {
  readonly total: number;
  readonly done: number;
}

function directParentIds(ticket: Ticket): readonly TicketId[] {
  const parentIds = new Set<TicketId>();

  if (ticket.parentId !== undefined) {
    parentIds.add(ticket.parentId);
  }

  for (const edge of ticket.dependencies) {
    if (
      edge.kind === 'parent-child' &&
      edge.issueId === ticket.id
    ) {
      parentIds.add(edge.dependsOnId);
    }
  }

  return [...parentIds];
}

export function buildDirectChildrenIndex(
  tickets: readonly Ticket[],
): Map<TicketId, TicketId[]> {
  const index = new Map<TicketId, TicketId[]>();

  for (const ticket of tickets) {
    for (const parentId of directParentIds(ticket)) {
      let children = index.get(parentId);
      if (children === undefined) {
        children = [];
        index.set(parentId, children);
      }

      if (!children.includes(ticket.id)) {
        children.push(ticket.id);
      }
    }
  }

  return index;
}

export function epicProgressFromIndex(
  parentId: TicketId,
  childrenIndex: ReadonlyMap<TicketId, readonly TicketId[]>,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): EpicProgress | null {
  const childIds = childrenIndex.get(parentId);
  if (childIds === undefined || childIds.length === 0) {
    return null;
  }

  let done = 0;
  for (const childId of childIds) {
    const child = ticketById.get(childId);
    if (child !== undefined && child.status === 'closed') {
      done += 1;
    }
  }

  return { total: childIds.length, done };
}

export function epicProgress(
  parentId: TicketId,
  tickets: readonly Ticket[],
): EpicProgress | null {
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const childrenIndex = buildDirectChildrenIndex(tickets);
  return epicProgressFromIndex(parentId, childrenIndex, ticketById);
}
