// bdboard-sso1.37: PresetControl.tsx の「行内リネーム」表示ブロックを移動しただけの
// コンポーネント。state は親(usePresetControlPopover)に残し、値とハンドラを props で
// 受け取る表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造は
// 移動前から変えていない。
import { isImeComposingKeyEvent } from '../../imeGuard';
import { BOARD_FILTER_PRESET_NAME_MAX_LENGTH } from '../../uiPersistedState';

export interface PresetControlRenameRowProps {
  presetName: string;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export function PresetControlRenameRow({
  presetName,
  renameDraft,
  onRenameDraftChange,
  onCommit,
  onCancel,
}: PresetControlRenameRowProps) {
  return (
    <div className="preset-control-rename">
      <input
        type="text"
        className="preset-control-name-input"
        aria-label={`「${presetName}」の新しい名前`}
        value={renameDraft}
        maxLength={BOARD_FILTER_PRESET_NAME_MAX_LENGTH}
        autoFocus
        onChange={(event) => {
          onRenameDraftChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            if (isImeComposingKeyEvent(event)) {
              return;
            }
            event.preventDefault();
            onCommit();
          }
        }}
      />
      <button type="button" className="btn btn-small" onClick={onCommit}>
        決定
      </button>
      <button type="button" className="btn btn-small" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}
