import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import type { DependencyGraphDto, GraphEdgeDto, GraphNodeDto } from '../api';
import { fetchDependencyGraph } from '../api';

export type FocusDepth = 1 | 2 | 'all';

export interface DependencyGraphViewProps {
  readonly projectIds: readonly string[];
  readonly focusTicketId?: string;
  onCardClick: (ticketId: string) => void;
}

export const MAX_NODES_UNFILTERED = 150;
const NODE_WIDTH = 176;
const NODE_HEIGHT = 52;
const LAYER_GAP = 40;
const NODE_GAP = 14;
const PADDING = 20;

interface NodeLayout {
  readonly node: GraphNodeDto;
  readonly x: number;
  readonly y: number;
}

function truncateTitle(title: string, maxLength = 28): string {
  if (title.length <= maxLength) {
    return title;
  }
  return `${title.slice(0, maxLength - 1)}…`;
}

function statusClassName(status: string): string {
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

function computeLayout(graph: DependencyGraphDto): {
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
      left.ticketId.localeCompare(right.ticketId),
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

function edgePath(
  from: NodeLayout,
  to: NodeLayout,
): string {
  const startX = from.x + NODE_WIDTH;
  const startY = from.y + NODE_HEIGHT / 2;
  const endX = to.x;
  const endY = to.y + NODE_HEIGHT / 2;
  const controlOffset = Math.max(24, (endX - startX) / 2);

  return `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`;
}

function renderEdge(
  edge: GraphEdgeDto,
  layoutById: ReadonlyMap<string, NodeLayout>,
  index: number,
): ReactElement | null {
  const fromLayout = layoutById.get(edge.from);
  const toLayout = layoutById.get(edge.to);
  if (fromLayout === undefined || toLayout === undefined) {
    return null;
  }

  const className =
    edge.kind === 'blocks'
      ? 'dependency-graph-edge dependency-graph-edge-blocks'
      : 'dependency-graph-edge dependency-graph-edge-parent-child';

  return (
    <path
      key={`${edge.from}-${edge.to}-${edge.kind}-${index}`}
      d={edgePath(toLayout, fromLayout)}
      className={className}
      fill="none"
    />
  );
}

export function DependencyGraphView({
  projectIds,
  focusTicketId,
  onCardClick,
}: DependencyGraphViewProps) {
  const projectIdsKey = projectIds.join(',');
  const query = useQuery({
    queryKey: ['dependency-graph', projectIdsKey],
    queryFn: () => fetchDependencyGraph(projectIds),
  });

  const [focusEnabled, setFocusEnabled] = useState(true);
  const [focusDepth, setFocusDepth] = useState<FocusDepth>(2);

  const fullGraph = query.data;
  const canFocus =
    focusTicketId !== undefined &&
    fullGraph !== undefined &&
    fullGraph.nodes.some((node) => node.ticketId === focusTicketId);
  const focusActive = canFocus && focusEnabled;

  const displayGraph = useMemo(() => {
    if (fullGraph === undefined) {
      return undefined;
    }
    if (!focusActive || focusTicketId === undefined) {
      return fullGraph;
    }
    return computeFocusedGraph(fullGraph, focusTicketId, focusDepth);
  }, [fullGraph, focusActive, focusTicketId, focusDepth]);

  const layout = useMemo(() => {
    if (displayGraph === undefined) {
      return null;
    }
    return computeLayout(displayGraph);
  }, [displayGraph]);

  const layoutById = useMemo(() => {
    if (layout === null) {
      return new Map<string, NodeLayout>();
    }
    return new Map(layout.nodes.map((entry) => [entry.node.ticketId, entry]));
  }, [layout]);

  const tooManyNodes =
    projectIds.length === 0 &&
    displayGraph !== undefined &&
    displayGraph.nodes.length >= MAX_NODES_UNFILTERED;

  return (
    <section className="dependency-graph" aria-label="依存グラフ">
      <div className="dependency-graph-header">
        <h2 className="dependency-graph-title">依存グラフ</h2>
        <p className="dependency-graph-legend">
          <span className="dependency-graph-legend-item dependency-graph-legend-blocks">
            実線: blocks
          </span>
          <span className="dependency-graph-legend-item dependency-graph-legend-parent-child">
            破線: parent-child
          </span>
        </p>
        {canFocus && (
          <div className="dependency-graph-focus-controls">
            <label className="dependency-graph-focus-toggle">
              <input
                type="checkbox"
                checked={focusEnabled}
                onChange={(event) => setFocusEnabled(event.target.checked)}
                aria-label="フォーカス表示"
              />
              選択チケット中心に表示
            </label>
            {focusEnabled && (
              <label className="dependency-graph-focus-depth">
                深さ
                <select
                  value={focusDepth === 'all' ? 'all' : String(focusDepth)}
                  onChange={(event) => {
                    const value = event.target.value;
                    setFocusDepth(value === 'all' ? 'all' : (Number(value) as FocusDepth));
                  }}
                  aria-label="フォーカス深さ"
                >
                  <option value="1">1ホップ</option>
                  <option value="2">2ホップ</option>
                  <option value="all">全連鎖</option>
                </select>
              </label>
            )}
            <button
              type="button"
              className="dependency-graph-show-all-button"
              onClick={() => setFocusEnabled(false)}
              disabled={!focusEnabled}
              aria-label="全体表示に戻す"
            >
              全体表示に戻す
            </button>
          </div>
        )}
        {focusActive && focusTicketId !== undefined && displayGraph !== undefined && fullGraph !== undefined && (
          <p className="dependency-graph-focus-status">
            {focusTicketId} を中心に {displayGraph.nodes.length} 件を表示中
            {fullGraph.nodes.length !== displayGraph.nodes.length &&
              `（全 ${fullGraph.nodes.length} 件）`}
          </p>
        )}
      </div>

      {query.isLoading && <p className="loading">読み込み中…</p>}
      {query.isError && (
        <p className="error-message">
          {query.error instanceof Error
            ? query.error.message
            : '依存グラフの読み込みに失敗しました'}
        </p>
      )}
      {tooManyNodes && (
        <p className="empty-message">
          ノード数が多すぎます（{displayGraph?.nodes.length}件）。プロジェクトを絞り込んでください。
        </p>
      )}
      {displayGraph !== undefined &&
        !tooManyNodes &&
        displayGraph.nodes.length === 0 && (
          <p className="empty-message">表示できる依存関係がありません</p>
        )}
      {layout !== null && !tooManyNodes && displayGraph !== undefined && displayGraph.nodes.length > 0 && (
        <div className="dependency-graph-scroll">
          <svg
            className="dependency-graph-canvas"
            width={layout.width}
            height={layout.height}
            role="img"
            aria-label="チケット依存関係グラフ"
          >
            <g className="dependency-graph-edges">
              {displayGraph.edges.map((edge, index) =>
                renderEdge(edge, layoutById, index),
              )}
            </g>
            <g className="dependency-graph-nodes">
              {layout.nodes.map(({ node, x, y }) => (
                <g
                  key={node.ticketId}
                  transform={`translate(${x}, ${y})`}
                  className="dependency-graph-node-group"
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.ticketId}: ${node.title}`}
                  onClick={() => onCardClick(node.ticketId)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onCardClick(node.ticketId);
                    }
                  }}
                >
                  <rect
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx={8}
                    className={`dependency-graph-node ${statusClassName(node.status)}${
                      focusActive && node.ticketId === focusTicketId
                        ? ' dependency-graph-node-focus-center'
                        : ''
                    }`}
                  />
                  <text x={10} y={18} className="dependency-graph-node-id">
                    {node.ticketId}
                  </text>
                  <text x={10} y={34} className="dependency-graph-node-title">
                    {truncateTitle(node.title)}
                  </text>
                  <text x={10} y={46} className="dependency-graph-node-meta">
                    {node.status}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        </div>
      )}
    </section>
  );
}
