// bdboard-sso1.41: DependencyGraphView.tsx にあった renderEdge() とその
// 呼び出し元 <g className="dependency-graph-edges"> ブロックを、挙動と DOM を
// 変えずにこの表示部品へ移したもの。props は 2 個、state は持たない。
import type { ReactElement } from 'react';
import type { GraphEdgeDto } from '../../api';
import { edgeClassName, edgePath, type NodeLayout } from './dependencyGraphHelpers';

export interface DependencyGraphEdgesProps {
  readonly edges: readonly GraphEdgeDto[];
  readonly layoutById: ReadonlyMap<string, NodeLayout>;
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

  return (
    <path
      key={`${edge.from}-${edge.to}-${edge.kind}-${index}`}
      d={edgePath(toLayout, fromLayout)}
      className={edgeClassName(edge)}
      fill="none"
    />
  );
}

export function DependencyGraphEdges({ edges, layoutById }: DependencyGraphEdgesProps) {
  return (
    <g className="dependency-graph-edges">
      {edges.map((edge, index) => renderEdge(edge, layoutById, index))}
    </g>
  );
}
