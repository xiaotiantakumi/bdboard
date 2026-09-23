import { describe, expect, it } from 'vitest';
import * as useBulkActionsModule from './useBulkActions';

/**
 * bdboard-sso1.60: web/src/components/bulk-action/useBulkActions.ts を
 * 関心別フック (./actions/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の useBulkActions.ts) から
 * `grep -nE '^export ' web/src/components/bulk-action/useBulkActions.ts` で
 * 機械的に採取した値エクスポート名をそのままハードコードしている
 * (useHygieneRepairActions.ts 分割 #618 / nextUpRunLoop.ts 分割 #614 の方式)。
 *
 * 型エクスポート (`export interface`) はここでは検証できないため、
 * useBulkActions-type-export-surface.check.ts (#618 の方式) を別途置く。
 */
const EXPECTED_VALUE_EXPORTS = ['useBulkActions'].sort();

describe('useBulkActions.ts export surface (bdboard-sso1.60 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(useBulkActionsModule).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
