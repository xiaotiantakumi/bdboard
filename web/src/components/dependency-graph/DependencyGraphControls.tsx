// bdboard-sso1.41: DependencyGraphView.tsx の <div className="dependency-graph-header">
// 内にあったタイトル・凡例・フォーカス操作・フォーカス状態文を、挙動と DOM を
// 変えずにこの表示部品へ移したもの。state は持たず、props は 9 個。
import type { FocusDepth } from './dependencyGraphHelpers';

export interface DependencyGraphControlsProps {
  readonly canFocus: boolean;
  readonly focusEnabled: boolean;
  readonly onFocusEnabledChange: (checked: boolean) => void;
  readonly focusDepth: FocusDepth;
  readonly onFocusDepthChange: (depth: FocusDepth) => void;
  readonly focusActive: boolean;
  readonly focusTicketId: string | undefined;
  readonly displayNodeCount: number | undefined;
  readonly fullNodeCount: number | undefined;
}

export function DependencyGraphControls({
  canFocus,
  focusEnabled,
  onFocusEnabledChange,
  focusDepth,
  onFocusDepthChange,
  focusActive,
  focusTicketId,
  displayNodeCount,
  fullNodeCount,
}: DependencyGraphControlsProps) {
  return (
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
              onChange={(event) => onFocusEnabledChange(event.target.checked)}
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
                  onFocusDepthChange(value === 'all' ? 'all' : (Number(value) as FocusDepth));
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
            onClick={() => onFocusEnabledChange(false)}
            disabled={!focusEnabled}
            aria-label="全体表示に戻す"
          >
            全体表示に戻す
          </button>
        </div>
      )}
      {focusActive &&
        focusTicketId !== undefined &&
        displayNodeCount !== undefined &&
        fullNodeCount !== undefined && (
          <p className="dependency-graph-focus-status">
            {focusTicketId} を中心に {displayNodeCount} 件を表示中
            {fullNodeCount !== displayNodeCount && `（全 ${fullNodeCount} 件）`}
          </p>
        )}
    </div>
  );
}
