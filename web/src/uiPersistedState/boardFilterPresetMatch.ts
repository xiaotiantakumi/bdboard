// bdboard-sso1.26: web/src/uiPersistedState.ts から move-only で分割。
// 挙動・型は変えていない (移動のみ)。
import { viewLabel } from './view';
import { UI_STORAGE_KEYS } from './storageKeys';
import type { BoardFilterPreset, BoardFilterPresetState } from './boardFilterPreset';

function stringArraysEqualUnordered(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightCounts = new Map<string, number>();
  for (const value of right) {
    rightCounts.set(value, (rightCounts.get(value) ?? 0) + 1);
  }
  for (const value of left) {
    const count = rightCounts.get(value);
    if (count === undefined || count === 0) {
      return false;
    }
    if (count === 1) {
      rightCounts.delete(value);
    } else {
      rightCounts.set(value, count - 1);
    }
  }
  return rightCounts.size === 0;
}

export function boardFilterPresetStatesEqual(
  left: BoardFilterPresetState,
  right: BoardFilterPresetState,
): boolean {
  return (
    left.view === right.view &&
    left.priorityCeiling === right.priorityCeiling &&
    left.filterText === right.filterText &&
    left.hideDone === right.hideDone &&
    left.stalledOnly === right.stalledOnly &&
    stringArraysEqualUnordered(left.issueTypes, right.issueTypes) &&
    stringArraysEqualUnordered(left.labels, right.labels) &&
    stringArraysEqualUnordered(left.selectedProjectIds, right.selectedProjectIds)
  );
}

export function findMatchingBoardFilterPreset(
  presets: readonly BoardFilterPreset[],
  state: BoardFilterPresetState,
): BoardFilterPreset | null {
  return presets.find((preset) => boardFilterPresetStatesEqual(preset, state)) ?? null;
}

/**
 * プリセットが復元する絞り込み状態が、このブラウザに1つでも保存済みかどうか。
 * 「既定」プリセットは、これが false のとき(= 実質的な初回起動)だけ自動適用する。
 */
export function hasStoredBoardFilterState(storage?: Pick<Storage, 'getItem'>): boolean {
  const keys = [
    UI_STORAGE_KEYS.view,
    UI_STORAGE_KEYS.selectedProjectIds,
    UI_STORAGE_KEYS.boardPriorityCeiling,
    UI_STORAGE_KEYS.boardIssueTypes,
    UI_STORAGE_KEYS.boardLabels,
    UI_STORAGE_KEYS.boardFilterText,
    UI_STORAGE_KEYS.hideDone,
    UI_STORAGE_KEYS.stalledOnly,
  ];
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (target === null) {
      return true; // 判定できないときは「保存済み」に倒して自動適用しない。
    }
    return keys.some((key) => target.getItem(key) !== null);
  } catch {
    return true;
  }
}

export function findDefaultBoardFilterPreset(
  presets: readonly BoardFilterPreset[],
): BoardFilterPreset | null {
  return presets.find((preset) => preset.isDefault === true) ?? null;
}

/**
 * プリセットの保存対象を1行で説明する。「現在の状態を保存」とだけ書いてあると何が
 * 保存されるのか分からない、というのが Turn 4 の出発点なので、実際に
 * BoardFilterPresetState が持っているものだけを、持っている粒度でそのまま並べる。
 */
export function describeBoardFilterPresetState(state: BoardFilterPresetState): string {
  const parts: string[] = [`ビュー: ${viewLabel(state.view)}`];

  parts.push(
    state.selectedProjectIds.length > 0
      ? `プロジェクト${state.selectedProjectIds.length}件`
      : '全プロジェクト',
  );

  if (state.priorityCeiling !== 'all') {
    parts.push(`P${state.priorityCeiling}以上`);
  }
  if (state.issueTypes.length > 0) {
    parts.push(`種別${state.issueTypes.length}件`);
  }
  if (state.labels.length > 0) {
    parts.push(`ラベル${state.labels.length}件`);
  }
  if (state.stalledOnly) {
    parts.push('滞留のみ');
  }
  if (!state.hideDone) {
    parts.push('完了も表示');
  }
  const filterText = state.filterText.trim();
  if (filterText !== '') {
    parts.push(`検索「${filterText}」`);
  }

  return parts.join(' / ');
}

export function sanitizeProjectFilter(
  selectedIds: string[],
  availableProjectIds: readonly string[],
): string[] {
  if (selectedIds.length === 0) {
    return selectedIds;
  }
  if (availableProjectIds.length === 0) {
    return [];
  }
  const validIds = new Set(availableProjectIds);
  const filtered = selectedIds.filter((id) => validIds.has(id));
  if (filtered.length === 0) {
    return [];
  }
  // 取り除くものが無いときは同じ参照を返す。呼び出し側(usePersistedState)が
  // 「変わっていないなら書かない」で判定できるようにするため。
  return filtered.length === selectedIds.length ? selectedIds : filtered;
}
