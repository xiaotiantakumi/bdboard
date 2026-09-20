import { describe, expect, it } from 'vitest';
import * as bdCliIssueWriter from './bd-cli-issue-writer.js';

/**
 * bdboard-sso1.24: src/infrastructure/bd/bd-cli-issue-writer.ts を機能別モジュール
 * (./bd-cli-issue-writer/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の bd-cli-issue-writer.ts) から
 * `grep -nE '^export ' src/infrastructure/bd/bd-cli-issue-writer.ts` で機械的に
 * 採取した値エクスポート名 (1件) をそのままハードコードしている。`export interface` は
 * TypeScript の型のみの宣言で実行時のバインディングを持たない (コンパイルで消える) ため、
 * `Object.keys()` には現れずこのリストにも含めていない — 型エクスポート面は
 * bd-cli-issue-writer-type-export-surface.check.ts が tsc (`npm run build`) で固定する
 * (dto.ts 分割, PR #540 / bd-cli-human-decisions.ts 分割, PR #555 と同じ方式)。
 *
 * 分割後の bd-cli-issue-writer.ts は各サブモジュールの関数を呼び出す
 * createBdCliIssueWriter() 本体だけを残す。ここが崩れる (関数名の変更・関数の削除) と、
 * この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = ['createBdCliIssueWriter'].sort();

describe('bd-cli-issue-writer.ts export surface (bdboard-sso1.24 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(bdCliIssueWriter).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
