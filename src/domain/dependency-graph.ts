import { compareStrings } from './compare.js';
import type { DependencyEdge } from './dependency.js';
import type { Priority, Status } from './status.js';
import type { Ticket } from './ticket.js';
import type { TicketId } from './ticket-id.js';

export interface GraphNode {
  readonly ticketId: TicketId;
  readonly projectId: string;
  readonly title: string;
  readonly status: Status;
  readonly priority: Priority;
  readonly issueType: string;
  readonly layer: number;
}

export interface GraphEdge {
  readonly from: TicketId;
  readonly to: TicketId;
  readonly kind: 'blocks' | 'parent-child';
}

export interface DependencyGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

const GRAPH_EDGE_KINDS = new Set<GraphEdge['kind']>(['blocks', 'parent-child']);

function isGraphEdgeKind(kind: DependencyEdge['kind']): kind is GraphEdge['kind'] {
  return GRAPH_EDGE_KINDS.has(kind as GraphEdge['kind']);
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}\0${edge.to}\0${edge.kind}`;
}

function assignLayersFromBlocks(
  blocksEdges: readonly GraphEdge[],
  nodeIds: ReadonlySet<TicketId>,
): Map<TicketId, number> {
  const layers = new Map<TicketId, number>();
  if (nodeIds.size === 0) {
    return layers;
  }

  const inDegree = new Map<TicketId, number>();
  const outgoing = new Map<TicketId, TicketId[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    outgoing.set(id, []);
  }

  for (const edge of blocksEdges) {
    const blocker = edge.to;
    const blocked = edge.from;
    if (!nodeIds.has(blocker) || !nodeIds.has(blocked)) {
      continue;
    }
    outgoing.get(blocker)?.push(blocked);
    inDegree.set(blocked, (inDegree.get(blocked) ?? 0) + 1);
  }

  let currentLayer = 0;
  let queue = [...nodeIds].filter((id) => inDegree.get(id) === 0);
  const remaining = new Set(nodeIds);

  while (queue.length > 0) {
    const nextQueue: TicketId[] = [];
    for (const id of queue) {
      if (!remaining.has(id)) {
        continue;
      }
      layers.set(id, currentLayer);
      remaining.delete(id);
      for (const child of outgoing.get(id) ?? []) {
        const nextDegree = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, nextDegree);
        if (nextDegree === 0) {
          nextQueue.push(child);
        }
      }
    }
    currentLayer += 1;
    queue = nextQueue;
  }

  for (const id of remaining) {
    layers.set(id, currentLayer);
  }

  return layers;
}

export function buildDependencyGraph(tickets: readonly Ticket[]): DependencyGraph {
  const ticketMap = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const edgeSet = new Map<string, GraphEdge>();

  for (const ticket of tickets) {
    for (const dependency of ticket.dependencies) {
      if (!isGraphEdgeKind(dependency.kind)) {
        continue;
      }

      const edge: GraphEdge = {
        from: dependency.issueId,
        to: dependency.dependsOnId,
        kind: dependency.kind,
      };

      if (!ticketMap.has(edge.from) || !ticketMap.has(edge.to)) {
        continue;
      }

      edgeSet.set(edgeKey(edge), edge);
    }
  }

  const edges = [...edgeSet.values()];
  const nodeIds = new Set<TicketId>();
  for (const edge of edges) {
    nodeIds.add(edge.from);
    nodeIds.add(edge.to);
  }

  const blocksNodeIds = new Set<TicketId>();
  const blocksEdges = edges.filter((edge) => {
    if (edge.kind !== 'blocks') {
      return false;
    }
    blocksNodeIds.add(edge.from);
    blocksNodeIds.add(edge.to);
    return true;
  });

  const layers = assignLayersFromBlocks(blocksEdges, blocksNodeIds);

  const nodes: GraphNode[] = [...nodeIds].map((ticketId) => {
    const ticket = ticketMap.get(ticketId);
    if (ticket === undefined) {
      throw new Error(`missing ticket for graph node ${ticketId}`);
    }

    return {
      ticketId,
      projectId: ticket.projectId,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      issueType: ticket.issueType,
      layer: layers.get(ticketId) ?? 0,
    };
  });

  nodes.sort((left, right) => compareStrings(left.ticketId, right.ticketId));
  edges.sort((left, right) => compareStrings(edgeKey(left), edgeKey(right)));

  return { nodes, edges };
}
