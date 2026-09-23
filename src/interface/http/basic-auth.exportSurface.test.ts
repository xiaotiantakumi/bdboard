import { describe, expect, it } from 'vitest';
import * as basicAuth from './basic-auth.js';

/**
 * bdboard-sso1.59: src/interface/http/basic-auth.ts を機能別モジュール
 * (./basic-auth/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の basic-auth.ts) から
 * `grep -nE '^export ' src/interface/http/basic-auth.ts` で機械的に
 * 採取した値エクスポート名 (2件) をそのままハードコードしている
 * (ps-process-scanner.ts 分割 #611 の方式)。
 *
 * 型エクスポート (`export interface BasicAuthConfig` / `export type AuthMode` /
 * `export interface BasicAuthMiddlewareOptions`) はここでは検証できないため、
 * basic-auth-type-export-surface.check.ts (dto.ts 分割 #540 の方式) を別途置く。
 */
const EXPECTED_VALUE_EXPORTS = ['createBasicAuthMiddleware', 'resolveAuthMode'].sort();

describe('basic-auth.ts export surface (bdboard-sso1.59 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(basicAuth).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
