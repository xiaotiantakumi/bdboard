import { describe, expect, it } from 'vitest';
import * as psProcessScanner from './ps-process-scanner.js';

/**
 * bdboard-sso1.47: src/infrastructure/process/ps-process-scanner.ts を機能別モジュール
 * (./ps-process-scanner/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の ps-process-scanner.ts) から
 * `grep -nE '^export ' src/infrastructure/process/ps-process-scanner.ts` で機械的に
 * 採取した値エクスポート名 (1件) をそのままハードコードしている
 * (ai-quota-source.ts 分割 #605 の方式)。
 *
 * 型エクスポート (`export interface PsProcessScannerOptions`) はここでは検証できない
 * ため、ps-process-scanner-type-export-surface.check.ts (dto.ts 分割 #540 の方式) を
 * 別途置く。
 */
const EXPECTED_VALUE_EXPORTS = ['createPsProcessScanner'].sort();

describe('ps-process-scanner.ts export surface (bdboard-sso1.47 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(psProcessScanner).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
