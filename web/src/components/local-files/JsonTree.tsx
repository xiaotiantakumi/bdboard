import type { ReactNode } from 'react';

export const DEFAULT_JSON_NODE_LIMIT = 2000;

export interface JsonTreeProps {
  readonly value: unknown;
  readonly nodeLimit?: number;
}

interface Piece {
  readonly node: ReactNode;
  readonly left: number;
  readonly truncated: boolean;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || (value !== null && typeof value === 'object');
}

function formatPrimitive(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function summaryLabel(value: unknown): string {
  if (Array.isArray(value)) return `[…] ${value.length} 件`;
  if (value !== null && typeof value === 'object') return `{…} ${Object.keys(value).length} 件`;
  return formatPrimitive(value);
}

function entriesOf(value: Record<string, unknown> | unknown[]): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
  return Object.entries(value);
}

function renderNode(value: unknown, left: number, keyLabel: string | null): Piece {
  if (left <= 0) return { node: null, left: 0, truncated: true };
  const next = left - 1;
  if (!isContainer(value)) {
    return {
      node: (
        <div className="local-json-primitive">
          {keyLabel !== null && <span className="local-json-key">{keyLabel}</span>}
          {keyLabel !== null && <span className="local-json-colon">: </span>}
          <span className="local-json-value">{formatPrimitive(value)}</span>
        </div>
      ),
      left: next,
      truncated: false,
    };
  }

  const children: ReactNode[] = [];
  let budget = next;
  let truncated = false;
  for (const [childKey, child] of entriesOf(value)) {
    const piece = renderNode(child, budget, childKey);
    budget = piece.left;
    truncated = truncated || piece.truncated;
    if (piece.node !== null) {
      children.push(<div key={childKey}>{piece.node}</div>);
    }
    if (truncated) break;
  }

  return {
    node: (
      <details className="local-json-node" open>
        <summary>
          {keyLabel !== null && <span className="local-json-key">{keyLabel}</span>}
          {keyLabel !== null && ' '}
          <span className="local-json-summary">{summaryLabel(value)}</span>
        </summary>
        <div className="local-json-children">{children}</div>
      </details>
    ),
    left: budget,
    truncated,
  };
}

export function JsonTree({ value, nodeLimit = DEFAULT_JSON_NODE_LIMIT }: JsonTreeProps) {
  const piece = renderNode(value, nodeLimit, null);
  return (
    <div className="local-json-tree">
      {piece.node}
      {piece.truncated && (
        <p className="local-file-note">大きいため先頭の {nodeLimit} 項目だけ表示しています。</p>
      )}
    </div>
  );
}
