// bdboard-sso1.26: web/src/uiPersistedState.ts から move-only で分割。
// 挙動・型は変えていない (移動のみ)。
import { validateViewMode, type ViewMode } from './view';
import {
  validateBoolean,
  validateIssueTypeArray,
  validateString,
  validateStringArray,
} from './validators';
import { validatePriorityCeiling, type PriorityCeilingChoice } from './priorityCeiling';

export const BOARD_FILTER_PRESET_NAME_MAX_LENGTH = 40;

export const DEFAULT_HIDE_DONE = true;
export const DEFAULT_STALLED_ONLY = false;

export interface BoardFilterPreset {
  id: string;
  name: string;
  view: ViewMode;
  selectedProjectIds: string[];
  priorityCeiling: PriorityCeilingChoice;
  issueTypes: string[];
  labels: string[];
  filterText: string;
  hideDone: boolean;
  stalledOnly: boolean;
  /*
    「既定にする」で選ばれたプリセット。保存済みの絞り込み状態がまだ1つも無い
    ブラウザ(= 初回起動)でだけ自動適用される。既に自分の絞り込みを持っている
    利用者の状態を勝手に上書きしないため、それ以外の場面では適用しない。
  */
  isDefault?: boolean;
}

export interface BoardFilterPresetState {
  view: ViewMode;
  selectedProjectIds: string[];
  priorityCeiling: PriorityCeilingChoice;
  issueTypes: string[];
  labels: string[];
  filterText: string;
  hideDone: boolean;
  stalledOnly: boolean;
}

function validateBoardFilterPreset(value: unknown): BoardFilterPreset | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    return null;
  }
  if (typeof record.name !== 'string') {
    return null;
  }
  const name = record.name.trim();
  if (name === '' || name.length > BOARD_FILTER_PRESET_NAME_MAX_LENGTH) {
    return null;
  }
  const view = validateViewMode(record.view);
  if (view === null) {
    return null;
  }
  const selectedProjectIds = validateStringArray(record.selectedProjectIds);
  if (selectedProjectIds === null) {
    return null;
  }
  const priorityCeiling = validatePriorityCeiling(record.priorityCeiling);
  if (priorityCeiling === null) {
    return null;
  }
  const issueTypes = validateIssueTypeArray(record.issueTypes);
  if (issueTypes === null) {
    return null;
  }
  const labels = validateStringArray(record.labels);
  if (labels === null) {
    return null;
  }
  const filterText = validateString(record.filterText);
  if (filterText === null) {
    return null;
  }
  let hideDone: boolean;
  if (record.hideDone === undefined) {
    hideDone = DEFAULT_HIDE_DONE;
  } else {
    const validatedHideDone = validateBoolean(record.hideDone);
    if (validatedHideDone === null) {
      return null;
    }
    hideDone = validatedHideDone;
  }
  let stalledOnly: boolean;
  if (record.stalledOnly === undefined) {
    stalledOnly = DEFAULT_STALLED_ONLY;
  } else {
    const validatedStalledOnly = validateBoolean(record.stalledOnly);
    if (validatedStalledOnly === null) {
      return null;
    }
    stalledOnly = validatedStalledOnly;
  }
  const preset: BoardFilterPreset = {
    id: record.id,
    name,
    view,
    selectedProjectIds,
    priorityCeiling,
    issueTypes,
    labels,
    filterText,
    hideDone,
    stalledOnly,
  };
  // 既存の保存データには isDefault が無いので、true のときだけ持たせる(欠損は false 扱い)。
  if (record.isDefault === true) {
    preset.isDefault = true;
  }
  return preset;
}

export function validateBoardFilterPresets(value: unknown): BoardFilterPreset[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const presets: BoardFilterPreset[] = [];
  const seenIds = new Set<string>();
  for (const item of value) {
    const preset = validateBoardFilterPreset(item);
    if (preset === null || seenIds.has(preset.id)) {
      return null;
    }
    seenIds.add(preset.id);
    presets.push(preset);
  }
  return presets;
}

export function createBoardFilterPresetId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
