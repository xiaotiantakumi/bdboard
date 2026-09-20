// bdboard-sso1.37: PresetControl.tsx から純粋ヘルパーを移動しただけのファイル。
// 挙動は一切変えていない。
import {
  BOARD_FILTER_PRESET_NAME_MAX_LENGTH,
  createBoardFilterPresetId,
  type BoardFilterPreset,
} from '../../uiPersistedState';

export function validatePresetName(
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

export function duplicateName(base: string, presets: readonly BoardFilterPreset[]): string {
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
