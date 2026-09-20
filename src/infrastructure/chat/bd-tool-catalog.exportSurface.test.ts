import { describe, expect, it } from 'vitest';
import * as bdToolCatalog from './bd-tool-catalog.js';

/**
 * bdboard-sso1.18: src/infrastructure/chat/bd-tool-catalog.ts を機能別モジュール
 * (./bd-tool-catalog/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の bd-tool-catalog.ts) から
 * `grep -nE '^export ' src/infrastructure/chat/bd-tool-catalog.ts` で機械的に採取した
 * 値エクスポート名 (2件) をそのままハードコードしている。`export interface` /
 * `export type` は TypeScript の型のみの宣言で実行時のバインディングを持たない
 * (コンパイルで消える) ため、`Object.keys()` には現れずこのリストにも含めていない —
 * 型エクスポート面は bd-tool-catalog-type-export-surface.check.ts が
 * tsc (`npm run build`) で固定する (dto.ts 分割, PR #540 と同じ方式)。
 *
 * 分割後の bd-tool-catalog.ts は各サブモジュールからの named re-export のみに
 * なった。ここが崩れる (関数の移し忘れ・名前の変更・re-export の欠落、または内部
 * ヘルパーの意図しない re-export による面の拡大) と、この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = ['BD_TOOL_DEFINITIONS', 'buildBdToolArgs'].sort();

describe('bd-tool-catalog.ts export surface (bdboard-sso1.18 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(bdToolCatalog).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
