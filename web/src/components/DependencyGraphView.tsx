import { DependencyGraphControls } from './dependency-graph/DependencyGraphControls';
import { DependencyGraphEdges } from './dependency-graph/DependencyGraphEdges';
import {
  computeFocusedGraph,
  MAX_NODES_UNFILTERED,
  type DependencyGraphViewProps,
  type FocusDepth,
} from './dependency-graph/dependencyGraphHelpers';
import { DependencyGraphNode } from './dependency-graph/DependencyGraphNode';
import { useDependencyGraphView } from './dependency-graph/useDependencyGraphView';

export type { FocusDepth };
export type { DependencyGraphViewProps };
export { computeFocusedGraph, MAX_NODES_UNFILTERED };

export function DependencyGraphView({
  projectIds,
  focusTicketId: externalFocusTicketId,
  onCardClick,
}: DependencyGraphViewProps) {
  const {
    query,
    focusTicketId,
    setFocusTicketId,
    focusEnabled,
    setFocusEnabled,
    focusDepth,
    setFocusDepth,
    canFocus,
    focusActive,
    fullGraph,
    displayGraph,
    layout,
    layoutById,
    tooManyNodes,
  } = useDependencyGraphView(projectIds, externalFocusTicketId);

  return (
    <section className="dependency-graph" aria-label="依存グラフ">
      <DependencyGraphControls
        canFocus={canFocus}
        focusEnabled={focusEnabled}
        onFocusEnabledChange={setFocusEnabled}
        focusDepth={focusDepth}
        onFocusDepthChange={setFocusDepth}
        focusActive={focusActive}
        focusTicketId={focusTicketId}
        displayNodeCount={displayGraph?.nodes.length}
        fullNodeCount={fullGraph?.nodes.length}
      />

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
            <DependencyGraphEdges edges={displayGraph.edges} layoutById={layoutById} />
            <g className="dependency-graph-nodes">
              {layout.nodes.map(({ node, x, y }) => (
                <DependencyGraphNode
                  key={node.ticketId}
                  node={node}
                  x={x}
                  y={y}
                  isFocusCenter={focusActive && node.ticketId === focusTicketId}
                  onSelect={setFocusTicketId}
                  onOpenDetail={onCardClick}
                />
              ))}
            </g>
          </svg>
        </div>
      )}
    </section>
  );
}
