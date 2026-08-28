import { useEffect, useMemo, useState } from 'react';
import {
  BOARD_FILTER_PRESET_NAME_MAX_LENGTH,
  createBoardFilterPresetId,
  describeBoardFilterPresetState,
  findMatchingBoardFilterPreset,
  type BoardFilterPreset,
  type BoardFilterPresetState,
} from '../uiPersistedState';
import { useExclusivePopover } from './PopoverCoordinator';

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

function validatePresetName(
  name: string,
  presets: readonly BoardFilterPreset[],
  excludeId: string | null,
): string | null {
  if (name === '') {
    return '名前を入力してください';
  }
  if (name.length > BOARD_FILTER_PRESET_NAME_MAX_LENGTH) {
    return `名前は${BOARD_FILTER_PRESET_NAME_MAX_LENGTH}文字以内にしてください`;
  }
  if (presets.some((preset) => preset.name === name && preset.id !== excludeId)) {
    return '同じ名前のプリセットが既にあります';
  }
  return null;
}

function duplicateName(base: string, presets: readonly BoardFilterPreset[]): string {
  const taken = new Set(presets.map((preset) => preset.name));
  const candidate = `${base} のコピー`;
  if (!taken.has(candidate) && candidate.length <= BOARD_FILTER_PRESET_NAME_MAX_LENGTH) {
    return candidate;
  }
  for (let index = 2; index < 100; index += 1) {
    const next = `${base} のコピー${index}`;
    if (!taken.has(next) && next.length <= BOARD_FILTER_PRESET_NAME_MAX_LENGTH) {
      return next;
    }
  }
  return createBoardFilterPresetId().slice(0, BOARD_FILTER_PRESET_NAME_MAX_LENGTH);
}

export function PresetControl({
  presets,
  onPresetsChange,
  currentState,
  onApplyPreset,
  saveIntentToken = 0,
}: PresetControlProps) {
  const [open, setOpen] = useState(false);
  const [lastAppliedId, setLastAppliedId] = useState<string | null>(null);
  const [menuPresetId, setMenuPresetId] = useState<string | null>(null);
  const [renamePresetId, setRenamePresetId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [newSaveOpen, setNewSaveOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const containerRef = useExclusivePopover('preset-control', open, setOpen);

  const matchingPreset = useMemo(
    () => findMatchingBoardFilterPreset(presets, currentState),
    [presets, currentState],
  );

  // 完全一致するプリセットがあればそれが現在のプリセット。無ければ最後に適用したものを
  // 「選択中だが変更あり」として見せる — 選び直せば戻せる、を示すための状態。
  const activePreset = useMemo(() => {
    if (matchingPreset !== null) {
      return matchingPreset;
    }
    return presets.find((preset) => preset.id === lastAppliedId) ?? null;
  }, [matchingPreset, presets, lastAppliedId]);

  const dirty = activePreset !== null && matchingPreset === null;

  const resetTransientState = () => {
    setMenuPresetId(null);
    setRenamePresetId(null);
    setRenameDraft('');
    setNewSaveOpen(false);
    setDraftName('');
    setError(null);
  };

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      resetTransientState();
    }
  };

  useEffect(() => {
    if (saveIntentToken > 0) {
      setOpen(true);
      setNewSaveOpen(true);
      setError(null);
    }
  }, [saveIntentToken]);

  // 排他クローズ(他のポップオーバーが開いた/Esc/外側クリック)で閉じたときも中の
  // 一時状態を残さない。
  useEffect(() => {
    if (!open) {
      resetTransientState();
    }
  }, [open]);

  const handleApply = (preset: BoardFilterPreset) => {
    onApplyPreset(preset);
    setLastAppliedId(preset.id);
    changeOpen(false);
  };

  const handleOverwrite = () => {
    if (activePreset === null) {
      return;
    }
    onPresetsChange(
      presets.map((preset) =>
        preset.id === activePreset.id ? { ...preset, ...currentState } : preset,
      ),
    );
    setLastAppliedId(activePreset.id);
    changeOpen(false);
  };

  const handleNewSave = () => {
    const name = draftName.trim();
    const message = validatePresetName(name, presets, null);
    if (message !== null) {
      setError(message);
      return;
    }
    const nextPreset: BoardFilterPreset = {
      id: createBoardFilterPresetId(),
      name,
      ...currentState,
    };
    onPresetsChange([...presets, nextPreset]);
    setLastAppliedId(nextPreset.id);
    changeOpen(false);
  };

  const handleRenameCommit = (preset: BoardFilterPreset) => {
    const name = renameDraft.trim();
    const message = validatePresetName(name, presets, preset.id);
    if (message !== null) {
      setError(message);
      return;
    }
    onPresetsChange(
      presets.map((item) => (item.id === preset.id ? { ...item, name } : item)),
    );
    setRenamePresetId(null);
    setRenameDraft('');
    setError(null);
  };

  const handleDuplicate = (preset: BoardFilterPreset) => {
    const copy: BoardFilterPreset = {
      ...preset,
      id: createBoardFilterPresetId(),
      name: duplicateName(preset.name, presets),
    };
    delete copy.isDefault;
    onPresetsChange([...presets, copy]);
    setMenuPresetId(null);
  };

  const handleToggleDefault = (preset: BoardFilterPreset) => {
    const makeDefault = preset.isDefault !== true;
    onPresetsChange(
      presets.map((item) => {
        const next = { ...item };
        delete next.isDefault;
        if (makeDefault && item.id === preset.id) {
          next.isDefault = true;
        }
        return next;
      }),
    );
    setMenuPresetId(null);
  };

  const handleDelete = (preset: BoardFilterPreset) => {
    onPresetsChange(presets.filter((item) => item.id !== preset.id));
    if (lastAppliedId === preset.id) {
      setLastAppliedId(null);
    }
    setMenuPresetId(null);
  };

  const buttonLabel =
    activePreset !== null ? `プリセット: ${activePreset.name}` : 'プリセット';

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
        <div className="preset-control-popover" role="dialog" aria-label="フィルタプリセット">
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
                  <div key={preset.id} className="preset-control-rename">
                    <input
                      type="text"
                      className="preset-control-name-input"
                      aria-label={`「${preset.name}」の新しい名前`}
                      value={renameDraft}
                      maxLength={BOARD_FILTER_PRESET_NAME_MAX_LENGTH}
                      autoFocus
                      onChange={(event) => {
                        setRenameDraft(event.target.value);
                        setError(null);
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => handleRenameCommit(preset)}
                    >
                      決定
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => {
                        setRenamePresetId(null);
                        setRenameDraft('');
                        setError(null);
                      }}
                    >
                      取消
                    </button>
                  </div>
                );
              }

              return (
                <div key={preset.id} className="preset-control-item">
                  <div className="preset-control-row">
                    <button
                      type="button"
                      className={`preset-control-apply${isActive ? ' preset-control-apply-active' : ''}`}
                      aria-pressed={isActive}
                      onClick={() => handleApply(preset)}
                    >
                      <span className="preset-control-check" aria-hidden="true">
                        {isActive ? '✓' : ''}
                      </span>
                      <span className="preset-control-name">{preset.name}</span>
                      {preset.isDefault === true && (
                        <span className="preset-control-badge preset-control-badge-default">
                          既定
                        </span>
                      )}
                      {isActive && dirty && (
                        <span className="preset-control-badge preset-control-badge-dirty">
                          変更あり
                        </span>
                      )}
                    </button>

                    <button
                      type="button"
                      className="preset-control-row-menu-button"
                      aria-haspopup="menu"
                      aria-expanded={menuPresetId === preset.id}
                      aria-label={`「${preset.name}」の操作`}
                      onClick={() =>
                        setMenuPresetId(menuPresetId === preset.id ? null : preset.id)
                      }
                    >
                      ⋯
                    </button>
                  </div>

                  {menuPresetId === preset.id && (
                    <div className="preset-control-row-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className="preset-control-row-menu-item"
                        onClick={() => {
                          setRenamePresetId(preset.id);
                          setRenameDraft(preset.name);
                          setMenuPresetId(null);
                          setError(null);
                        }}
                      >
                        名前を変更
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="preset-control-row-menu-item"
                        onClick={() => handleDuplicate(preset)}
                      >
                        複製
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="preset-control-row-menu-item"
                        onClick={() => handleToggleDefault(preset)}
                      >
                        {preset.isDefault === true ? '既定を解除' : '既定にする'}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="preset-control-row-menu-item preset-control-row-menu-danger"
                        onClick={() => handleDelete(preset)}
                      >
                        削除
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="popover-foot preset-control-foot">
            <p className="preset-control-target">
              いまの絞り込み: {describeBoardFilterPresetState(currentState)}
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
                    setDraftName(event.target.value);
                    setError(null);
                  }}
                />
                <button type="button" className="btn btn-small" onClick={handleNewSave}>
                  保存
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    setNewSaveOpen(false);
                    setDraftName('');
                    setError(null);
                  }}
                >
                  取消
                </button>
              </div>
            ) : (
              <div className="preset-control-save-actions">
                {activePreset !== null && (
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={!dirty}
                    onClick={handleOverwrite}
                  >
                    「{activePreset.name}」を上書き
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    setNewSaveOpen(true);
                    setError(null);
                  }}
                >
                  新規保存…
                </button>
              </div>
            )}

            {error !== null && <p className="preset-control-error">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
