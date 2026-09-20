// bdboard-sso1.41: DependencyGraphView.tsx にあった純ロジック(型・定数・
// レイアウト計算・フォーカス計算・パス計算)を、挙動を変えずにこのファイルへ
// 移したもの。関数の中身・呼び出し順・計算式は移動前と同一。
import type { DependencyGraphDto, GraphEdgeDto, GraphNodeDto } from '../../api';
import { compareStrings } from '../../compare';

export type FocusDepth = 1 | 2 | 'all';

export interface DependencyGraphViewProps {
  readonly projectIds: readonly string[];
  readonly focusTicketId?: string;
  onCardClick: (ticketId: string) => void;
}

export const MAX_NODES_UNFILTERED = 150;
export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 52;
const LAYER_GAP = 40;
const NODE_GAP = 14;
const PADDING = 20;

export interface NodeLayout {
  readonly node: GraphNodeDto;
  readonly x: number;
  readonly y: number;
}

export function truncateTitle(title: string, maxLength = 28): string {
  if (title.length <= maxLength) {
    return title;
  }
  return `${title.slice(0, maxLength - 1)}…`;
}

export function statusClassName(status: string): string {
  const normalized = status.replace(/[^a-z0-9_-]/gi, '-');
  return `dependency-graph-node-status dependency-graph-node-status-${normalized}`;
}

export function computeFocusedGraph(
  graph: DependencyGraphDto,
  focusTicketId: string,
  depth: FocusDepth,
): DependencyGraphDto {
  const nodeIds = new Set(graph.nodes.map((node) => node.ticketId));
  if (!nodeIds.has(focusTicketId)) {
    return graph;
  }

  const adjacency = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    adjacency.set(node.ticketId, new Set());
  }
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }

  const visited = new Set<string>();
  const queue: Array<{ id: string; hop: number }> = [{ id: focusTicketId, hop: 0 }];
  visited.add(focusTicketId);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const { id, hop } = current;
    if (depth !== 'all' && hop >= depth) {
      continue;
    }
    for (const neighbor of adjacency.get(id) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ id: neighbor, hop: hop + 1 });
      }
    }
  }

  const nodes = graph.nodes.filter((node) => visited.has(node.ticketId));
  const edges = graph.edges.filter(
    (edge) => visited.has(edge.from) && visited.has(edge.to),
  );

  return { nodes, edges };
}

export function computeLayout(graph: DependencyGraphDto): {
  readonly nodes: readonly NodeLayout[];
  readonly width: number;
  readonly height: number;
} {
  const layers = new Map<number, GraphNodeDto[]>();
  for (const node of graph.nodes) {
    const bucket = layers.get(node.layer) ?? [];
    bucket.push(node);
    layers.set(node.layer, bucket);
  }

  const sortedLayerKeys = [...layers.keys()].sort((left, right) => left - right);
  const nodeLayouts: NodeLayout[] = [];
  let maxColumnHeight = 0;

  for (const [columnIndex, layer] of sortedLayerKeys.entries()) {
    const columnNodes = (layers.get(layer) ?? []).sort((left, right) =>
      compareStrings(left.ticketId, right.ticketId),
    );
    const columnHeight =
      columnNodes.length * NODE_HEIGHT + Math.max(0, columnNodes.length - 1) * NODE_GAP;
    maxColumnHeight = Math.max(maxColumnHeight, columnHeight);

    columnNodes.forEach((node, rowIndex) => {
      nodeLayouts.push({
        node,
        x: PADDING + columnIndex * (NODE_WIDTH + LAYER_GAP),
        y: PADDING + rowIndex * (NODE_HEIGHT + NODE_GAP),
      });
    });
  }

  const width =
    PADDING * 2 +
    Math.max(0, sortedLayerKeys.length) * NODE_WIDTH +
    Math.max(0, sortedLayerKeys.length - 1) * LAYER_GAP;
  const height = PADDING * 2 + maxColumnHeight;

  return { nodes: nodeLayouts, width: Math.max(width, NODE_WIDTH + PADDING * 2), height };
}

export function edgePath(from: NodeLayout, to: NodeLayout): string {
  const startX = from.x + NODE_WIDTH;
  const startY = from.y + NODE_HEIGHT / 2;
  const endX = to.x;
  const endY = to.y + NODE_HEIGHT / 2;
  const controlOffset = Math.max(24, (endX - startX) / 2);

  return `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`;
}

export function edgeClassName(edge: GraphEdgeDto): string {
  return edge.kind === 'blocks'
    ? 'dependency-graph-edge dependency-graph-edge-blocks'
    : 'dependency-graph-edge dependency-graph-edge-parent-child';
}
