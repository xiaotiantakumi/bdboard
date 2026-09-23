// bdboard-sso1.70: BoardFilterBar.tsx のモバイル用トグル行(絞り込みボタン+折りたたみ時
// の解除ボタン)を移動しただけの表示専用コンポーネント。state は親(useBoardFilterBar)に
// 残し、値とハンドラを props で受け取る。JSX・className・aria属性・文言・DOM構造は
// 移動前から変えていない。
import type { RefObject } from 'react';

export interface BoardFilterMobileToggleProps {
  toggleRef: RefObject<HTMLButtonElement | null>;
  expanded: boolean;
  toggleAriaLabel: string;
  filterActive: boolean;
  activeFilterCount: number;
  onToggleClick: () => void;
  onClearClick: () => void;
}

export function BoardFilterMobileToggle({
  toggleRef,
  expanded,
  toggleAriaLabel,
  filterActive,
  activeFilterCount,
  onToggleClick,
  onClearClick,
}: BoardFilterMobileToggleProps) {
  return (
    <div className="board-filter-toggle-row">
      <button
        type="button"
        ref={toggleRef}
        className="board-filter-toggle"
        aria-label={toggleAriaLabel}
        aria-expanded={expanded}
        aria-controls={expanded ? 'board-filter-panel' : undefined}
        onClick={onToggleClick}
      >
        <span className="board-filter-toggle-label">絞り込み</span>
        {filterActive && (
          <span className="board-filter-active-badge" aria-hidden="true">
            {activeFilterCount}
          </span>
        )}
      </button>
      {/* 折りたたみ時 (!expanded) かつ filterActive のときだけ表示する。
          展開時は board-filter-panel 側に既存の「フィルタ解除」があるため重複させない。
          常時表示にするとトグル行が常に2要素になり、折りたたみで稼いだ縦の節約を削るので
          条件付きのままにすること (bdboard-jch5)。

          アクセシブル名はパネル側の解除ボタンと同じ「フィルタ解除」にしてある。
          「絞り込みを解除」だとトグル本体の名前「絞り込み」の接頭辞拡張になり、
          e2e の getByRole('button', { name: /^絞り込み/ }) が2要素に当たって
          strict mode violation になる (board-filter-breakpoint /
          board-filter-mobile-reach / mobile-input-font-size /
          fixtures/mobile-chrome-helpers の assertBoardFilterBarCollapsed)。
          パネル側とは !expanded / expanded で排他なので同名でも衝突しない。
          可視ラベル「解除」は「フィルタ解除」に含まれるので WCAG 2.5.3 を満たす。 */}
      {!expanded && filterActive && (
        <button
          type="button"
          className="board-filter-toggle-clear"
          aria-label="フィルタ解除"
          onClick={onClearClick}
        >
          解除
        </button>
      )}
    </div>
  );
}
