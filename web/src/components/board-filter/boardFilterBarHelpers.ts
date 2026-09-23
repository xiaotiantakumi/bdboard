// bdboard-sso1.70: BoardFilterBar.tsx の純ヘルパー・定数を移動しただけのファイル。
// 関数本体・定数値は移動前から変えていない。
import type { PriorityCeilingChoice } from '../../uiPersistedState';

/**
 * 盤面から消えたのに選択だけ残っているラベル (availableLabels に無いが labels にある)
 * のチップに付ける補足。id は sr-only な説明要素と aria-describedby の両側で共有する。
 * bdboard-we44 でチップ自体は描かれるようになったが、押された見た目が生きたチップと
 * 同じままだったので「0 件になっている理由」が読み取れなかった (bdboard-gxq5)。
 */
export const MISSING_LABEL_HINT_ID = 'board-filter-missing-label-hint';
export const MISSING_LABEL_HINT_TEXT = '現在の盤面には無いラベルです';

export const PRIORITY_CEILING_OPTIONS: { value: PriorityCeilingChoice; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: '0', label: 'P0' },
  { value: '1', label: 'P0-P1' },
  { value: '2', label: 'P0-P2' },
  { value: '3', label: 'P0-P3' },
  { value: '4', label: 'P0-P4' },
];

export function isFilterActive(
  priorityCeiling: PriorityCeilingChoice,
  issueTypes: string[],
  labels: string[],
  filterText: string,
): boolean {
  return countActiveFilters(priorityCeiling, issueTypes, labels, filterText) > 0;
}

export function countActiveFilters(
  priorityCeiling: PriorityCeilingChoice,
  issueTypes: string[],
  labels: string[],
  filterText: string,
): number {
  let count = 0;
  if (priorityCeiling !== 'all') {
    count += 1;
  }
  count += issueTypes.length;
  count += labels.length;
  if (filterText.trim() !== '') {
    count += 1;
  }
  return count;
}
