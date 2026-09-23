import { describe, expect, it } from 'vitest';
import * as useHygieneRepairActionsModule from './useHygieneRepairActions';

/**
 * bdboard-sso1.55: web/src/components/hygiene/useHygieneRepairActions.ts を
 * 関心別フック (./repair-actions/*.ts) へ分割した際の、実行時エクスポート面の
 * 回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の useHygieneRepairActions.ts) から
 * `grep -nE '^export ' web/src/components/hygiene/useHygieneRepairActions.ts` で
 * 機械的に採取した値エクスポート名をそのままハードコードしている
 * (nextUpRunLoop.ts 分割 #614 / ps-process-scanner.ts 分割 #611 の方式)。
 *
 * 型エクスポート (`export type` / `export interface`) はここでは検証できないため、
 * useHygieneRepairActions-type-export-surface.check.ts (dto.ts 分割 #540 の方式) を
 * 別途置く。
 */
const EXPECTED_VALUE_EXPORTS = ['useHygieneRepairActions'].sort();

describe('useHygieneRepairActions.ts export surface (bdboard-sso1.55 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(useHygieneRepairActionsModule).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
