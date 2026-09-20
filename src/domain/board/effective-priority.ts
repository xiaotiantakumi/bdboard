import { compareStrings } from '../compare.js';
import { computeStronglyConnectedComponents } from '../graph-scc.js';
import type { Priority } from '../status.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';

interface SuccessorMinResult {
  minPriority: Priority | null;
  inheritedFrom: TicketId | null;
}

export interface EffectivePriorityResult {
  effectivePriority: Priority;
  priorityInheritedFrom: TicketId | null;
}

function mergeSuccessorCandidate(
  result: SuccessorMinResult,
  id: TicketId,
  priority: Priority,
): void {
  if (result.minPriority === null || priority < result.minPriority) {
    result.minPriority = priority;
    result.inheritedFrom = id;
    return;
  }

  if (
    priority === result.minPriority &&
    result.inheritedFrom !== null &&
    compareStrings(id, result.inheritedFrom) < 0
  ) {
    result.inheritedFrom = id;
  }
}

export function computeEffectivePriorities(
  tickets: readonly Ticket[],
  blocksIndex: Map<TicketId, TicketId[]>,
): Map<TicketId, EffectivePriorityResult> {
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));

  function isEligibleSuccessor(id: TicketId): boolean {
    const ticket = ticketById.get(id);
    return ticket !== undefined && ticket.status !== 'closed';
  }

  function neighbors(id: TicketId): readonly TicketId[] {
    return (blocksIndex.get(id) ?? []).filter(isEligibleSuccessor);
  }

  const { sccMembers, sccOf } = computeStronglyConnectedComponents(
    tickets.map((ticket) => ticket.id),
    neighbors,
  );

  const sccResultMemo = new Map<number, SuccessorMinResult>();

  function sccOwnMin(componentIndex: number): SuccessorMinResult {
    const result: SuccessorMinResult = { minPriority: null, inheritedFrom: null };
    for (const memberId of sccMembers[componentIndex]) {
      if (isEligibleSuccessor(memberId)) {
        mergeSuccessorCandidate(result, memberId, ticketById.get(memberId)!.priority);
      }
    }
    return result;
  }

  function sccDownstreamMin(componentIndex: number): SuccessorMinResult {
    const memoized = sccResultMemo.get(componentIndex);
    if (memoized !== undefined) {
      return memoized;
    }

    const result = sccOwnMin(componentIndex);

    for (const memberId of sccMembers[componentIndex]) {
      for (const succId of neighbors(memberId)) {
        const succComponent = sccOf.get(succId)!;
        if (succComponent === componentIndex) {
          continue;
        }
        const sub = sccDownstreamMin(succComponent);
        if (sub.minPriority !== null && sub.inheritedFrom !== null) {
          mergeSuccessorCandidate(result, sub.inheritedFrom, sub.minPriority);
        }
      }
    }

    sccResultMemo.set(componentIndex, result);
    return result;
  }

  const results = new Map<TicketId, EffectivePriorityResult>();
  for (const ticket of tickets) {
    const componentIndex = sccOf.get(ticket.id)!;
    const successorMin = sccDownstreamMin(componentIndex);
    const effectivePriority =
      successorMin.minPriority === null
        ? ticket.priority
        : (Math.min(ticket.priority, successorMin.minPriority) as Priority);
    const priorityInheritedFrom =
      successorMin.minPriority !== null && successorMin.minPriority < ticket.priority
        ? successorMin.inheritedFrom
        : null;

    results.set(ticket.id, { effectivePriority, priorityInheritedFrom });
  }

  return results;
}
