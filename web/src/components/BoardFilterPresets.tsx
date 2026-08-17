import { useMemo, useState } from 'react';
import {
  BOARD_FILTER_PRESET_NAME_MAX_LENGTH,
  createBoardFilterPresetId,
  findMatchingBoardFilterPreset,
  type BoardFilterPreset,
  type BoardFilterPresetState,
} from '../uiPersistedState';

export interface BoardFilterPresetsProps {
  presets: BoardFilterPreset[];
  onPresetsChange: (presets: BoardFilterPreset[]) => void;
  currentState: BoardFilterPresetState;
  onApplyPreset: (preset: BoardFilterPreset) => void;
}

export function BoardFilterPresets({
  presets,
  onPresetsChange,
  currentState,
  onApplyPreset,
}: BoardFilterPresetsProps) {
  const [draftName, setDraftName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  const activePreset = useMemo(
    () => findMatchingBoardFilterPreset(presets, currentState),
    [presets, currentState],
  );

  const handleSavePreset = () => {
    const name = draftName.trim();
    if (name === '') {
      setSaveError('名前を入力してください');
      return;
    }
    if (name.length > BOARD_FILTER_PRESET_NAME_MAX_LENGTH) {
      setSaveError(`名前は${BOARD_FILTER_PRESET_NAME_MAX_LENGTH}文字以内にしてください`);
      return;
    }
    if (presets.some((preset) => preset.name === name)) {
      setSaveError('同じ名前のプリセットが既にあります');
      return;
    }

    const nextPreset: BoardFilterPreset = {
      id: createBoardFilterPresetId(),
      name,
      ...currentState,
    };
    onPresetsChange([...presets, nextPreset]);
    setDraftName('');
    setSaveError(null);
  };

  const handleDeletePreset = (presetId: string) => {
    onPresetsChange(presets.filter((preset) => preset.id !== presetId));
  };

  return (
    <div className="header-group filter-presets" role="group" aria-label="フィルタプリセット">
      <span className="header-label">プリセット</span>
      {presets.length > 0 && (
        <div className="toggle-group filter-preset-group">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`toggle-btn${activePreset?.id === preset.id ? ' active' : ''}`}
              aria-pressed={activePreset?.id === preset.id}
              onClick={() => onApplyPreset(preset)}
            >
              {preset.name}
            </button>
          ))}
        </div>
      )}
      <details className="filter-preset-manage">
        <summary>管理</summary>
        <div className="filter-preset-manage-panel">
          <div className="filter-preset-save">
            <label className="header-label" htmlFor="filter-preset-name">
              現在の状態を保存
            </label>
            <div className="filter-preset-save-row">
              <input
                id="filter-preset-name"
                type="text"
                className="filter-preset-name-input"
                value={draftName}
                maxLength={BOARD_FILTER_PRESET_NAME_MAX_LENGTH}
                placeholder="例: P1バグだけ"
                onChange={(event) => {
                  setDraftName(event.target.value);
                  if (saveError !== null) {
                    setSaveError(null);
                  }
                }}
              />
              <button type="button" className="btn btn-small" onClick={handleSavePreset}>
                保存
              </button>
            </div>
            {saveError !== null && <p className="filter-preset-error">{saveError}</p>}
          </div>
          {presets.length > 0 && (
            <ul className="filter-preset-list">
              {presets.map((preset) => (
                <li key={preset.id} className="filter-preset-list-item">
                  <span>{preset.name}</span>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => handleDeletePreset(preset.id)}
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}
