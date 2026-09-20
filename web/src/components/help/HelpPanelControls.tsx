// bdboard-sso1.28: HelpPanel.tsx の絞り込み入力欄+件数表示+すべて開閉ボタンを
// 移動しただけの表示専用コンポーネント (move-only)。state・ハンドラは親
// (HelpPanel) に残し、値とハンドラを props で受け取る。JSX・className・
// 文言・DOM 構造は移動前から変えていない。
import type {
  ChangeEvent,
  CompositionEvent,
  KeyboardEvent,
} from 'react';

export interface HelpPanelControlsProps {
  filterQuery: string;
  onFilterChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onFilterBlur: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => void;
  onFilterKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  filterCountText: string;
  liveFilterCountText: string;
  allFilteredOpen: boolean;
  onToggleAll: () => void;
  filteredSectionsCount: number;
}

export function HelpPanelControls({
  filterQuery,
  onFilterChange,
  onFilterBlur,
  onCompositionStart,
  onCompositionEnd,
  onFilterKeyDown,
  filterCountText,
  liveFilterCountText,
  allFilteredOpen,
  onToggleAll,
  filteredSectionsCount,
}: HelpPanelControlsProps) {
  return (
    <div className="help-panel-controls">
      <label className="help-panel-filter-label">
        <span className="help-panel-filter-label-text">絞り込み</span>
        <input
          type="search"
          className="help-panel-filter-input"
          value={filterQuery}
          onChange={onFilterChange}
          onBlur={onFilterBlur}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onKeyDownCapture={onFilterKeyDown}
          placeholder="キーワードでセクションを絞り込む"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="help-panel-controls-meta">
        <p className="help-panel-filter-count" aria-hidden="true">
          {filterCountText}
        </p>
        <span className="sr-only" role="status" aria-live="polite">
          {liveFilterCountText}
        </span>
        <button
          type="button"
          className="btn help-panel-toggle-all"
          onClick={onToggleAll}
          disabled={filteredSectionsCount === 0}
        >
          {allFilteredOpen ? 'すべて閉じる' : 'すべて開く'}
        </button>
      </div>
    </div>
  );
}
