import type { TicketId } from './ticket-id.js';

export interface StronglyConnectedComponents {
  readonly sccMembers: readonly (readonly TicketId[])[];
  readonly sccOf: ReadonlyMap<TicketId, number>;
}

/**
 * Tarjan's algorithm for strongly connected components on a directed graph.
 *
 * Callers supply `neighbors` to control which edges are traversed:
 * - board.ts (priority propagation): excludes closed tickets so priority does
 *   not flow through closed successors.
 * - hygiene.ts (cycle detection): includes all known tickets regardless of
 *   status so cycles are detected from graph structure alone.
 */
export function computeStronglyConnectedComponents(
  nodeIds: readonly TicketId[],
  neighbors: (id: TicketId) => readonly TicketId[],
): StronglyConnectedComponents {
  let indexCounter = 0;
  const indices = new Map<TicketId, number>();
  const lowlink = new Map<TicketId, number>();
  const onStack = new Set<TicketId>();
  const tarjanStack: TicketId[] = [];
  const sccOf = new Map<TicketId, number>();
  const sccMembers: TicketId[][] = [];

  function strongConnect(v: TicketId): void {
    indices.set(v, indexCounter);
    lowlink.set(v, indexCounter);
    indexCounter += 1;
    tarjanStack.push(v);
    onStack.add(v);

    for (const w of neighbors(v)) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: TicketId[] = [];
      let w: TicketId;
      do {
        w = tarjanStack.pop()!;
        onStack.delete(w);
        component.push(w);
        sccOf.set(w, sccMembers.length);
      } while (w !== v);
      sccMembers.push(component);
    }
  }

  for (const id of nodeIds) {
    if (!indices.has(id)) {
      strongConnect(id);
    }
  }

  return { sccMembers, sccOf };
}
