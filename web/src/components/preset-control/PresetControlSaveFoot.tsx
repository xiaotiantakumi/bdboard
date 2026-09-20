// bdboard-sso1.37: PresetControl.tsx のポップオーバーフッター(保存対象の説明+
// 新規保存/上書き)を移動しただけのコンポーネント。state は親
// (usePresetControlPopover)に残し、値とハンドラを props で受け取る表示専用
// コンポーネント。JSX・className・aria属性・文言・DOM構造は移動前から変えていない。
import { isImeComposingKeyEvent } from '../../imeGuard';
import { BOARD_FILTER_PRESET_NAME_MAX_LENGTH } from '../../uiPersistedState';

export interface PresetControlSaveFootProps {
  currentStateDescription: string;
  activePresetName: string | null;
  dirty: boolean;
  newSaveOpen: boolean;
  draftName: string;
  onDraftNameChange: (value: string) => void;
  onSave: () => void;
  onCancelSave: () => void;
  onStartSave: () => void;
  onOverwrite: () => void;
  error: string | null;
}

export function PresetControlSaveFoot({
  currentStateDescription,
  activePresetName,
  dirty,
  newSaveOpen,
  draftName,
  onDraftNameChange,
  onSave,
  onCancelSave,
  onStartSave,
  onOverwrite,
  error,
}: PresetControlSaveFootProps) {
  return (
    <div className="popover-foot preset-control-foot">
      <p className="preset-control-target">
        いまの絞り込み: {currentStateDescription}
      </p>

      {newSaveOpen ? (
        <div className="preset-control-save-row">
          <input
            type="text"
            className="preset-control-name-input"
            aria-label="新しいプリセットの名前"
            placeholder="例: P1バグだけ"
            value={draftName}
            maxLength={BOARD_FILTER_PRESET_NAME_MAX_LENGTH}
            autoFocus
            onChange={(event) => {
              onDraftNameChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                if (isImeComposingKeyEvent(event)) {
                  return;
                }
                event.preventDefault();
                onSave();
              }
            }}
          />
          <button type="button" className="btn btn-small" onClick={onSave}>
            保存
          </button>
          <button type="button" className="btn btn-small" onClick={onCancelSave}>
            取消
          </button>
        </div>
      ) : (
        <div className="preset-control-save-actions">
          {activePresetName !== null && (
            <button
              type="button"
              className="btn btn-small"
              disabled={!dirty}
              onClick={onOverwrite}
            >
              「{activePresetName}」を上書き
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={onStartSave}>
            新規保存…
          </button>
        </div>
      )}

      {error !== null && <p className="preset-control-error">{error}</p>}
    </div>
  );
}
