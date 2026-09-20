import { describe, expect, it } from 'vitest';
import * as sqliteBoardCache from './sqlite-board-cache.js';

/**
 * bdboard-sso1.19: src/infrastructure/cache/sqlite-board-cache.ts を機能別モジュール
 * (./sqlite-board-cache/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の sqlite-board-cache.ts) から
 * `grep -nE '^export ' src/infrastructure/cache/sqlite-board-cache.ts` で機械的に
 * 採取した値エクスポート名 (3件) をそのままハードコードしている。分割前の
 * sqlite-board-cache.ts は `export type` / `export interface` を一切持たない
 * (型は全て他モジュールからの import のみで、再エクスポートされていない) ため、
 * 型エクスポート面の回帰ガード (dto.ts 分割, PR #540 や bd-cli-human-decisions.ts 分割,
 * PR #555 が置いている `*-type-export-surface.check.ts`) はここでは不要 —
 * 守るべき型エクスポート面が空集合だから。
 *
 * 分割後の sqlite-board-cache.ts は createSqliteBoardCache() 本体 (コンストラクタ) と、
 * 残り2件の named re-export のみになった。ここが崩れる (関数の移し忘れ・名前の変更・
 * re-export の欠落、または内部ヘルパーの意図しない re-export による面の拡大) と、
 * この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = ['MAX_INTERACTIONS', 'createSqliteBoardCache', 'openCacheDatabase'].sort();

describe('sqlite-board-cache.ts export surface (bdboard-sso1.19 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(sqliteBoardCache).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
