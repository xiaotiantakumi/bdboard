import { useEffect, useRef, useState } from 'react';
import { compareStrings } from '../../compare';
import type { BoardFilterState } from '../../hooks/useBoardFilterState';
import { usePopoverViewportClamp } from '../../hooks/usePopoverViewportClamp';
import {
  DEFAULT_HIDE_DONE,
  type BoardFilterPreset,
  type BoardFilterPresetState,
} from '../../uiPersistedState';
import { BoardFilterPanel } from '../board-filter/BoardFilterPanel';
import { countActiveFilters } from '../board-filter/boardFilterBarHelpers';
import { PresetControl } from '../PresetControl';
import { togglePressedProps } from '../toggleGroupA11y';
import { useMenuDismiss } from './useMenuDismiss';

export interface HeaderFilterPresets {
  list: BoardFilterPreset[];
  onChange: (presets: BoardFilterPreset[]) => void;
  state: BoardFilterPresetState;
  onApply: (preset: BoardFilterPreset) => void;
  saveIntentToken: number;
}

export interface HeaderFilterProps {
  filterState: BoardFilterState;
  availableLabels: string[] | undefined;
  presets: HeaderFilterPresets;
}

/** ヘッダーの「フィルタ」バッジに出す件数。検索欄の文字は検索欄で見えているので数えない。 */
export function countHeaderFilters(state: BoardFilterState): number {
  const base = countActiveFilters(state.priorityCeiling, state.issueTypes, state.labels, '');
  return base + (state.stalledOnly ? 1 : 0) + (state.hideDone === DEFAULT_HIDE_DONE ? 0 : 1);
}

function FilterChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`filter-chip${active ? ' filter-chip-active' : ''}`}
      {...togglePressedProps(active)}
      onClick={onToggle}
    >
      {label}
      {active && <span className="filter-chip-clear" aria-hidden="true">✕</span>}
    </button>
  );
}

export interface HeaderFilterMenuProps extends HeaderFilterProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** モバイルでは ⋯ メニューの項目から開くので、ボタン自身は出さない。 */
  showButton: boolean;
}

export function HeaderFilterMenu({
  filterState: state,
  availableLabels,
  presets,
  open,
  onOpenChange,
  showButton,
}: HeaderFilterMenuProps) {
  const containerRef = useMenuDismiss(open, () => onOpenChange(false));
  const popoverRef = usePopoverViewportClamp<HTMLDivElement>(open);
  const count = countHeaderFilters(state);
  const labelOptions = [...new Set([...(availableLabels ?? []), ...state.labels])].sort(
    compareStrings,
  );
  const availableSet = new Set(availableLabels ?? []);
  const isMissingLabel = (label: string) =>
    availableLabels !== undefined && !availableSet.has(label);

  // 「この組み合わせを保存」(プロジェクト選択) は、プリセットの保存欄を開く合図。
  // プリセットはこのメニューの中にあるので、メニューごと開く。開いた経緯が無い通常の
  // 開閉では 0 を渡し、PresetControl が勝手に保存欄を開かないようにする。
  const [intent, setIntent] = useState(0);
  const lastTokenRef = useRef(presets.saveIntentToken);
  useEffect(() => {
    if (presets.saveIntentToken !== lastTokenRef.current) {
      lastTokenRef.current = presets.saveIntentToken;
      setIntent(presets.saveIntentToken);
      onOpenChange(true);
    }
  }, [presets.saveIntentToken, onOpenChange]);
  useEffect(() => {
    if (!open) {
      setIntent(0);
    }
  }, [open]);

  const handleClear = () => {
    state.setPriorityCeiling('all');
    state.setIssueTypes([]);
    state.setLabels([]);
    state.setFilterText('');
  };

  return (
    <div ref={containerRef} className="filter-menu header-group">
      {showButton && (
        <button
          type="button"
          className="btn filter-menu-button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={count > 0 ? `フィルタ (${count}件適用中)` : 'フィルタ'}
          onClick={() => onOpenChange(!open)}
        >
          フィルタ
          {count > 0 && (
            <span className="filter-menu-badge" aria-hidden="true">
              {count}
            </span>
          )}
        </button>
      )}

      {open && (
        <div
          ref={popoverRef}
          className="filter-menu-popover"
          role="dialog"
          aria-label="フィルタ"
        >
          <BoardFilterPanel
            priorityCeiling={state.priorityCeiling}
            onPriorityCeilingChange={state.setPriorityCeiling}
            issueTypes={state.issueTypes}
            onIssueTypeToggle={(type) =>
              state.setIssueTypes(
                state.issueTypes.includes(type)
                  ? state.issueTypes.filter((item) => item !== type)
                  : [...state.issueTypes, type],
              )
            }
            labelOptions={labelOptions}
            labels={state.labels}
            onLabelToggle={(label) =>
              state.setLabels(
                state.labels.includes(label)
                  ? state.labels.filter((item) => item !== label)
                  : [...state.labels, label],
              )
            }
            isMissingLabel={isMissingLabel}
            hasMissingLabel={labelOptions.some(isMissingLabel)}
            onClearFilter={count > 0 || state.filterText !== '' ? handleClear : undefined}
          />
          <div className="filter-menu-row">
            <PresetControl
              presets={presets.list}
              onPresetsChange={presets.onChange}
              currentState={presets.state}
              onApplyPreset={presets.onApply}
              saveIntentToken={intent}
            />
          </div>
          <div className="filter-menu-row">
            <FilterChip
              label="done レーンを隠す"
              active={state.hideDone}
              onToggle={() => state.setHideDone(!state.hideDone)}
            />
            <FilterChip
              label="滞留のみ表示"
              active={state.stalledOnly}
              onToggle={() => state.setStalledOnly(!state.stalledOnly)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
