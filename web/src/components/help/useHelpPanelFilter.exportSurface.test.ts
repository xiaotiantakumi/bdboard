import { describe, expect, it } from 'vitest';
import * as useHelpPanelFilterModule from './useHelpPanelFilter';

/**
 * bdboard-sso1.67: web/src/components/help/useHelpPanelFilter.ts を関心別
 * ヘルパー/フック (./helpPanelSectionSets.ts, ./useHelpPanelFilteredSections.ts,
 * ./useHelpPanelSectionActions.ts, ./useHelpPanelFilterInputHandlers.ts) へ分割
 * した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、origin/main の useHelpPanelFilter.ts) から
 * `grep -nE '^export ' web/src/components/help/useHelpPanelFilter.ts` で機械的に
 * 採取した値エクスポート名をそのままハードコードしている
 * (useHygieneRepairActions.ts 分割 #618 と同じ方式)。分割前は
 * `export function useHelpPanelFilter()` のみで、`export type` / `export interface`
 * は無いため、型エクスポート面の回帰ガード (dto.ts 分割 #540 方式の .check.ts) は
 * 不要。
 */
const EXPECTED_VALUE_EXPORTS = ['useHelpPanelFilter'].sort();

describe('useHelpPanelFilter.ts export surface (bdboard-sso1.67 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(useHelpPanelFilterModule).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
