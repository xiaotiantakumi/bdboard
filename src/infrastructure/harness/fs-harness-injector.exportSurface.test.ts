import { describe, expect, it } from 'vitest';
import * as fsHarnessInjector from './fs-harness-injector.js';

/**
 * bdboard-sso1.40: src/infrastructure/harness/fs-harness-injector.ts を機能別モジュール
 * (./fs-harness-injector/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の fs-harness-injector.ts) から
 * `grep -nE '^export ' src/infrastructure/harness/fs-harness-injector.ts` で機械的に
 * 採取した値エクスポート名 (2件) をそのままハードコードしている。分割前の同ファイルに
 * `export interface` / `export type` は無いため、型エクスポート面の回帰ガード
 * (*-type-export-surface.check.ts、dto.ts 分割 PR #540 の方式) は不要。
 *
 * 分割後の fs-harness-injector.ts は各サブモジュールへ委譲する薄い入口だけを残す。
 * ここが崩れる (関数名の変更・削除) と、この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = ['createFsHarnessInjector', 'isHookScript'].sort();

describe('fs-harness-injector.ts export surface (bdboard-sso1.40 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(fsHarnessInjector).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
