// bdboard-sso1.37: PresetControl.tsx の state・popover 制御・関心固有ハンドラを
// 束ねた関心別フック。フックの呼び出し順・依存配列・effect 発火順・cleanup 順・
// ref 共有関係は移動前と同一(呼び出し元 PresetControl はこのフック1つだけを
// 呼び出すため、Reactから見た通算のフック呼び出し順序は変わらない)。挙動は
// 一切変えていない。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createBoardFilterPresetId,
  findMatchingBoardFilterPreset,
  type BoardFilterPreset,
  type BoardFilterPresetState,
} from '../../uiPersistedState';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { usePopoverViewportClamp } from '../../hooks/usePopoverViewportClamp';
import { useExclusivePopover } from '../PopoverCoordinator';
import { duplicateName, validatePresetName } from './presetControlHelpers';

export interface UsePresetControlPopoverParams {
  presets: BoardFilterPreset[];
  onPresetsChange: (presets: BoardFilterPreset[]) => void;
  currentState: BoardFilterPresetState;
  onApplyPreset: (preset: BoardFilterPreset) => void;
  saveIntentToken: number;
}

export function usePresetControlPopover({
  presets,
  onPresetsChange,
  currentState,
  onApplyPreset,
  saveIntentToken,
}: UsePresetControlPopoverParams) {
  const [open, setOpen] = useState(false);
  const [lastAppliedId, setLastAppliedId] = useState<string | null>(null);
  const [menuPresetId, setMenuPresetId] = useState<string | null>(null);
  const [renamePresetId, setRenamePresetId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [newSaveOpen, setNewSaveOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const containerRef = useExclusivePopover('preset-control', open, setOpen);
  const popoverRef = useRef<HTMLDivElement>(null);
  const clampRef = usePopoverViewportClamp<HTMLDivElement>(open);
  const setPopoverRef = useCallback(
    (node: HTMLDivElement | null) => {
      popoverRef.current = node;
      clampRef(node);
    },
    [clampRef],
  );

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

  // useExclusivePopover は document 単位で Escape/外側クリックの排他クローズを処理する。
  // useFocusTrap の Escape ハンドラは event.preventDefault() してから閉じるので、
  // ポップオーバー内(popoverRef の子孫)で発生した Escape はここで処理が完結し、
  // document まで浮上した時点で useExclusivePopover 側は defaultPrevented を見て
  // 二重発火せずに早期returnする(PopoverCoordinator.tsx の handleKeyDown 参照)。
  useFocusTrap({
    containerRef: popoverRef,
    enabled: open,
    onEscape: () => changeOpen(false),
  });

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

  return {
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
  };
}
