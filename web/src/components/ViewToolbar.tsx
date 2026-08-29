import type { BoardFilterPreset, BoardFilterPresetState } from '../uiPersistedState';
import type { ViewMode } from '../uiPersistedState';
import { AiQuotaWidget } from './AiQuotaWidget';
import { PresetControl } from './PresetControl';

export interface ViewToolbarProps {
  view: ViewMode;
  boardFilterPresets: BoardFilterPreset[];
  onBoardFilterPresetsChange: (presets: BoardFilterPreset[]) => void;
  boardFilterPresetState: BoardFilterPresetState;
  onApplyBoardFilterPreset: (preset: BoardFilterPreset) => void;
  hideDone: boolean;
  onHideDoneChange: (value: boolean) => void;
  stalledOnly: boolean;
  onStalledOnlyChange: (value: boolean) => void;
  totalSessionCount: number;
  activeSessionCount: number;
  onOpenSessionList: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  chatAvailable: boolean;
  onOpenChat: () => void;
  presetSaveIntentToken: number;
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
      aria-pressed={active}
      onClick={onToggle}
    >
      {label}
      {active && <span className="filter-chip-clear" aria-hidden="true">✕</span>}
    </button>
  );
}

export function ViewToolbar({
  view,
  boardFilterPresets,
  onBoardFilterPresetsChange,
  boardFilterPresetState,
  onApplyBoardFilterPreset,
  hideDone,
  onHideDoneChange,
  stalledOnly,
  onStalledOnlyChange,
  totalSessionCount,
  activeSessionCount,
  onOpenSessionList,
  onRefresh,
  isRefreshing,
  chatAvailable,
  onOpenChat,
  presetSaveIntentToken,
}: ViewToolbarProps) {
  const showBoardFilters = view === 'merged' || view === 'split';

  return (
    <div className="view-toolbar">
      <div className="view-toolbar-left">
        <PresetControl
          presets={boardFilterPresets}
          onPresetsChange={onBoardFilterPresetsChange}
          currentState={boardFilterPresetState}
          onApplyPreset={onApplyBoardFilterPreset}
          saveIntentToken={presetSaveIntentToken}
        />

        {showBoardFilters && (
          <>
            <FilterChip
              label="done レーンを隠す"
              active={hideDone}
              onToggle={() => onHideDoneChange(!hideDone)}
            />
            <FilterChip
              label="滞留のみ表示"
              active={stalledOnly}
              onToggle={() => onStalledOnlyChange(!stalledOnly)}
            />
          </>
        )}
      </div>

      <div className="view-toolbar-right">
        <button
          type="button"
          className="meta-text meta-text-btn"
          onClick={() => onOpenSessionList()}
        >
          セッション: {totalSessionCount}（稼働中 {activeSessionCount}）
        </button>

        <AiQuotaWidget />

        <button type="button" className="btn" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? '更新中…' : '手動更新'}
        </button>

        {chatAvailable && (
          <button type="button" className="btn" onClick={onOpenChat}>
            チャット
          </button>
        )}
      </div>
    </div>
  );
}
