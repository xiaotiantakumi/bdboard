import {
  describeBoardFilterPresetState,
  type BoardFilterPreset,
  type BoardFilterPresetState,
} from '../uiPersistedState';
import { usePresetControlPopover } from './preset-control/usePresetControlPopover';
import { PresetControlItemRow } from './preset-control/PresetControlItemRow';
import { PresetControlRenameRow } from './preset-control/PresetControlRenameRow';
import { PresetControlSaveFoot } from './preset-control/PresetControlSaveFoot';

/*
  Header Redesign Turn 4 / 4b。「プリセット」と「管理」の2ボタンを1つに統合し、
  選ぶ・保存する・整理するを同じポップオーバーの中で行う。「現在の状態を保存」だけだと
  何が保存されるのか分からないので、保存前に対象を1行で示し、上書きと新規を分ける。
*/

export interface PresetControlProps {
  presets: BoardFilterPreset[];
  onPresetsChange: (presets: BoardFilterPreset[]) => void;
  currentState: BoardFilterPresetState;
  onApplyPreset: (preset: BoardFilterPreset) => void;
  /** 増えるたびにポップオーバーを開いて新規保存欄を出す(4a の「この組み合わせを保存」から)。 */
  saveIntentToken?: number;
}

export function PresetControl({
  presets,
  onPresetsChange,
  currentState,
  onApplyPreset,
  saveIntentToken = 0,
}: PresetControlProps) {
  const {
    open,
    changeOpen,
    containerRef,
    setPopoverRef,
    activePreset,
    dirty,
    buttonLabel,
    menuPresetId,
    setMenuPresetId,
    renamePresetId,
    setRenamePresetId,
    renameDraft,
    setRenameDraft,
    newSaveOpen,
    setNewSaveOpen,
    draftName,
    setDraftName,
    error,
    setError,
    handleApply,
    handleOverwrite,
    handleNewSave,
    handleRenameCommit,
    handleDuplicate,
    handleToggleDefault,
    handleDelete,
  } = usePresetControlPopover({
    presets,
    onPresetsChange,
    currentState,
    onApplyPreset,
    saveIntentToken,
  });

  return (
    <div ref={containerRef} className="preset-control header-group">
      <button
        type="button"
        className="preset-control-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`フィルタプリセット: ${activePreset?.name ?? '未選択'}`}
        onClick={() => changeOpen(!open)}
      >
        <span className="preset-control-button-label">{buttonLabel}</span>
        <span className="preset-control-caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div
          ref={setPopoverRef}
          className="preset-control-popover"
          role="dialog"
          aria-label="フィルタプリセット"
        >
          <div className="preset-control-list">
            {presets.length === 0 && (
              <p className="preset-control-empty">
                プリセットはまだありません。いまの絞り込みを保存できます。
              </p>
            )}

            {presets.map((preset) => {
              const isActive = activePreset?.id === preset.id;
              if (renamePresetId === preset.id) {
                return (
                  <PresetControlRenameRow
                    key={preset.id}
                    presetName={preset.name}
                    renameDraft={renameDraft}
                    onRenameDraftChange={(value) => {
                      setRenameDraft(value);
                      setError(null);
                    }}
                    onCommit={() => handleRenameCommit(preset)}
                    onCancel={() => {
                      setRenamePresetId(null);
                      setRenameDraft('');
                      setError(null);
                    }}
                  />
                );
              }

              return (
                <PresetControlItemRow
                  key={preset.id}
                  preset={preset}
                  isActive={isActive}
                  dirty={dirty}
                  isMenuOpen={menuPresetId === preset.id}
                  onApply={() => handleApply(preset)}
                  onToggleMenu={() =>
                    setMenuPresetId(menuPresetId === preset.id ? null : preset.id)
                  }
                  onStartRename={() => {
                    setRenamePresetId(preset.id);
                    setRenameDraft(preset.name);
                    setMenuPresetId(null);
                    setError(null);
                  }}
                  onDuplicate={() => handleDuplicate(preset)}
                  onToggleDefault={() => handleToggleDefault(preset)}
                  onDelete={() => handleDelete(preset)}
                />
              );
            })}
          </div>

          <PresetControlSaveFoot
            currentStateDescription={describeBoardFilterPresetState(currentState)}
            activePresetName={activePreset?.name ?? null}
            dirty={dirty}
            newSaveOpen={newSaveOpen}
            draftName={draftName}
            onDraftNameChange={(value) => {
              setDraftName(value);
              setError(null);
            }}
            onSave={handleNewSave}
            onCancelSave={() => {
              setNewSaveOpen(false);
              setDraftName('');
              setError(null);
            }}
            onStartSave={() => {
              setNewSaveOpen(true);
              setError(null);
            }}
            onOverwrite={handleOverwrite}
            error={error}
          />
        </div>
      )}
    </div>
  );
}
