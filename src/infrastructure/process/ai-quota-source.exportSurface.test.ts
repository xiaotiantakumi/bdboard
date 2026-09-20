import { describe, expect, it } from 'vitest';
import * as aiQuotaSource from './ai-quota-source.js';

/**
 * bdboard-sso1.42: src/infrastructure/process/ai-quota-source.ts を機能別モジュール
 * (./ai-quota-source/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の ai-quota-source.ts) から
 * `grep -nE '^export ' src/infrastructure/process/ai-quota-source.ts` で機械的に
 * 採取した値エクスポート名 (2件) をそのままハードコードしている
 * (fs-harness-injector.ts 分割 #603 の方式)。
 *
 * 型エクスポート (`export interface NodeAiQuotaSourceOptions`) はここでは検証できない
 * ため、ai-quota-source-type-export-surface.check.ts (dto.ts 分割 #540 の方式) を別途置く。
 */
const EXPECTED_VALUE_EXPORTS = ['createNodeAiQuotaSource', 'parseAiQuotaOutput'].sort();

describe('ai-quota-source.ts export surface (bdboard-sso1.42 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(aiQuotaSource).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
