import { describe, expect, it } from 'vitest';
import * as board from './board.js';

/**
 * bdboard-sso1.34: src/domain/board.ts を関心別モジュール (./board/*.ts) へ
 * 分割する際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (このコミット時点) の board.ts から
 * `grep -nE '^export (const|function|async function) [A-Za-z0-9_]+' src/domain/board.ts`
 * で機械的に採取した値エクスポート名 (3件) をそのままハードコードしている。
 * `export interface` / `export type` は TypeScript の型のみの宣言で実行時のバインディングを
 * 持たない (コンパイルで消える) ため `Object.keys()` には現れずこのリストにも含めていない —
 * 型エクスポート面は board-type-export-surface.check.ts が tsc (`npm run build`) で固定する。
 *
 * 分割後の board.ts は名前を明示した re-export (harness-contract.ts の分割
 * (PR #568) / hygiene.ts の分割 (PR #556) / dto.ts の分割 (PR #540) と同じ方式) のみになる。
 * ここが崩れる (関数の移し忘れ・名前の変更・re-export の欠落) と、この一覧との差分として
 * すぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = ['compareCards', 'buildBoard', 'mergeBoards'].sort();

describe('board.ts export surface (bdboard-sso1.34 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split board.ts', () => {
    const actual = Object.keys(board).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
