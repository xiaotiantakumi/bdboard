// bdboard-sso1.41: DependencyGraphView.tsx の layout.nodes.map(...) 内にあった
// 1ノード分の <g> ブロック(クリック領域 + 詳細ボタン)を、挙動と DOM を変えずに
// この表示部品へ移したもの。呼び出し元は key を付けて描画する(key はリスト側で
// 管理するため props には含めない)。state は持たず、props は 6 個。
import type { GraphNodeDto } from '../../api';
import { NODE_HEIGHT, NODE_WIDTH, statusClassName, truncateTitle } from './dependencyGraphHelpers';

export interface DependencyGraphNodeProps {
  readonly node: GraphNodeDto;
  readonly x: number;
  readonly y: number;
  readonly isFocusCenter: boolean;
  readonly onSelect: (ticketId: string) => void;
  readonly onOpenDetail: (ticketId: string) => void;
}

export function DependencyGraphNode({
  node,
  x,
  y,
  isFocusCenter,
  onSelect,
  onOpenDetail,
}: DependencyGraphNodeProps) {
  return (
    <g
      transform={`translate(${x}, ${y})`}
      className="dependency-graph-node-group"
    >
      <g
        className="dependency-graph-node-clickarea"
        role="button"
        tabIndex={0}
        aria-label={`${node.ticketId}: ${node.title}`}
        onClick={() => onSelect(node.ticketId)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(node.ticketId);
          }
        }}
      >
        <rect
          width={NODE_WIDTH}
          height={NODE_HEIGHT}
          rx={8}
          className={`dependency-graph-node ${statusClassName(node.status)}${
            isFocusCenter ? ' dependency-graph-node-focus-center' : ''
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
      <g
        className="dependency-graph-node-detail-button"
        role="button"
        tabIndex={0}
        aria-label={`${node.ticketId} の詳細を開く`}
        onClick={(event) => {
          event.stopPropagation();
          onOpenDetail(node.ticketId);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onOpenDetail(node.ticketId);
          }
        }}
      >
        <rect
          x={NODE_WIDTH - 34}
          y={4}
          width={30}
          height={14}
          rx={3}
          className="dependency-graph-node-detail-button-bg"
        />
        <text
          x={NODE_WIDTH - 19}
          y={14}
          textAnchor="middle"
          className="dependency-graph-node-detail-button-label"
        >
          詳細
        </text>
      </g>
    </g>
  );
}
