// bdboard-sso1.26: web/src/uiPersistedState.ts から move-only で分割。
// 挙動・型は変えていない (移動のみ)。
import type { BoardMode } from '../api';

export type ViewMode =
  | 'merged'
  | 'split'
  | 'next'
  | 'activity'
  | 'digest'
  | 'stats'
  | 'graph'
  | 'hygiene'
  | 'events'
  | 'settings';

export const DEFAULT_VIEW: ViewMode = 'merged';

/*
  ビュー切替タブの並び順とラベルの単一原本。GlobalBar のタブ列と、プリセットの
  保存対象サマリ(describeBoardFilterPresetState)の両方がここを参照する。
*/
export const VIEW_ITEMS: readonly { view: ViewMode; label: string }[] = [
  { view: 'merged', label: '統合' },
  { view: 'split', label: '分割' },
  { view: 'next', label: 'Next Up' },
  { view: 'activity', label: 'アクティビティ' },
  { view: 'digest', label: 'ダイジェスト' },
  { view: 'stats', label: '統計' },
  { view: 'hygiene', label: '健全性' },
  { view: 'graph', label: '依存グラフ' },
  { view: 'events', label: 'イベント' },
  { view: 'settings', label: '設定' },
];

export function viewLabel(view: ViewMode): string {
  return VIEW_ITEMS.find((item) => item.view === view)?.label ?? view;
}

export function validateBoardMode(value: unknown): BoardMode | null {
  if (value === 'merged' || value === 'split') {
    return value;
  }
  return null;
}

export function validateViewMode(value: unknown): ViewMode | null {
  if (
    value === 'merged' ||
    value === 'split' ||
    value === 'next' ||
    value === 'activity' ||
    value === 'digest' ||
    value === 'stats' ||
    value === 'graph' ||
    value === 'hygiene' ||
    value === 'events' ||
    value === 'settings'
  ) {
    return value;
  }
  return null;
}

export function boardApiModeFromView(view: ViewMode): BoardMode {
  return view === 'split' ? 'split' : 'merged';
}
