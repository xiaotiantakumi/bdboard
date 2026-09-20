import { compareStrings } from '../compare.js';
import { computeStronglyConnectedComponents } from '../graph-scc.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';
import type { DependencyCycle, HygieneCycleEdge } from './types.js';

function buildBlocksIndex(
  tickets: readonly Ticket[],
  ticketById: ReadonlyMap<TicketId, Ticket>,
): Map<TicketId, TicketId[]> {
  const index = new Map<TicketId, TicketId[]>();

  for (const ticket of tickets) {
    for (const edge of ticket.dependencies) {
      if (edge.kind !== 'blocks') {
        continue;
      }
      if (!ticketById.has(edge.issueId) || !ticketById.has(edge.dependsOnId)) {
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

function compareCycleEdges(
  a: HygieneCycleEdge,
  b: HygieneCycleEdge,
): number {
  const issueDiff = compareStrings(a.issueId, b.issueId);
  if (issueDiff !== 0) {
    return issueDiff;
  }
  return compareStrings(a.dependsOnId, b.dependsOnId);
}

function collectCycleEdges(
  tickets: readonly Ticket[],
  memberSet: ReadonlySet<TicketId>,
): readonly HygieneCycleEdge[] {
  const seen = new Set<string>();
  const edges: HygieneCycleEdge[] = [];

  for (const ticket of tickets) {
    for (const edge of ticket.dependencies) {
      if (edge.kind !== 'blocks') {
        continue;
      }
      if (!memberSet.has(edge.issueId) || !memberSet.has(edge.dependsOnId)) {
        continue;
      }

      const key = `${edge.issueId}\0${edge.dependsOnId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({ issueId: edge.issueId, dependsOnId: edge.dependsOnId });
    }
  }

  return edges.sort(compareCycleEdges);
}

export function findDependencyCycles(
  tickets: readonly Ticket[],
): readonly DependencyCycle[] {
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const blocksIndex = buildBlocksIndex(tickets, ticketById);

  function neighbors(id: TicketId): readonly TicketId[] {
    return (blocksIndex.get(id) ?? []).filter((successor) => ticketById.has(successor));
  }

  const { sccMembers } = computeStronglyConnectedComponents(
    tickets.map((ticket) => ticket.id),
    neighbors,
  );

  const cycles: DependencyCycle[] = [];

  for (const component of sccMembers) {
    if (component.length < 2) {
      continue;
    }

    const ticketIds = [...component].sort(compareStrings);
    const memberSet = new Set(ticketIds);
    const edges = collectCycleEdges(tickets, memberSet);
    cycles.push({ ticketIds, edges });
  }

  return cycles.sort((a, b) => compareStrings(a.ticketIds[0]!, b.ticketIds[0]!));
}
