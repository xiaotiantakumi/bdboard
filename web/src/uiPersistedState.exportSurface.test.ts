import { describe, expect, it } from 'vitest';
import * as uiPersistedState from './uiPersistedState';

/**
 * bdboard-sso1.26: web/src/uiPersistedState.ts を関心別モジュール
 * (./uiPersistedState/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前の uiPersistedState.ts から
 * `grep -oE '^export (class|function|async function|const) [A-Za-z0-9_]+' web/src/uiPersistedState.ts`
 * で機械的に採取した値エクスポート名 (40件) をそのままハードコードしている。
 * `export interface` / `export type` は TypeScript の型のみの宣言で実行時の
 * バインディングを持たない (コンパイルで消える) ため、`Object.keys()` には現れず
 * このリストにも含めていない — 含めるべきなのは `class` / `function` /
 * `async function` / `const` の4種だけ。
 *
 * 分割後の uiPersistedState.ts は `export * from './uiPersistedState/xxx'` の
 * 再エクスポート入口のみになった。ここが崩れる (関数の移し忘れ・名前の変更・
 * re-export の欠落) と、この一覧との差分としてすぐ検出できる。
 * 手本: web/src/api.ts の分割 (PR #527) と web/src/api.exportSurface.test.ts。
 */
const EXPECTED_VALUE_EXPORTS = [
  'ACTIVITY_WINDOW_DAYS',
  'BOARD_FILTER_PRESET_NAME_MAX_LENGTH',
  'BOARD_ISSUE_TYPES',
  'DEFAULT_HIDE_DONE',
  'DEFAULT_STALLED_ONLY',
  'DEFAULT_TIPS_BANNER_DISMISSED',
  'DEFAULT_VIEW',
  'RECENT_TICKETS_MAX',
  'STATS_WEEKS',
  'UI_STORAGE_KEYS',
  'VIEW_ITEMS',
  'activityWindowLabel',
  'boardApiModeFromView',
  'boardFilterPresetStatesEqual',
  'createBoardFilterPresetId',
  'describeBoardFilterPresetState',
  'findDefaultBoardFilterPreset',
  'findMatchingBoardFilterPreset',
  'hasStoredBoardFilterState',
  'priorityCeilingValue',
  'recordRecentTicket',
  'sanitizeProjectFilter',
  'statsWeeksLabel',
  'validateActivityWindowDays',
  'validateBoardFilterPresets',
  'validateBoardMode',
  'validateBoolean',
  'validateChatModelSelections',
  'validateIssueTypeArray',
  'validateLaneArray',
  'validatePriorityCeiling',
  'validateRecentTickets',
  'validateStatsWeeks',
  'validateString',
  'validateStringArray',
  'validateViewMode',
  'validateWatchedTicketIds',
  'viewLabel',
].sort();

describe('uiPersistedState.ts export surface (bdboard-sso1.26 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split uiPersistedState.ts', () => {
    const actual = Object.keys(uiPersistedState).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
