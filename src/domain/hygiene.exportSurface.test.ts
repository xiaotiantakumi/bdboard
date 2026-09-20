import { describe, expect, it } from 'vitest';
import * as hygiene from './hygiene.js';

/**
 * bdboard-sso1.15: src/domain/hygiene.ts を検出項目の種類別モジュール (./hygiene/*.ts) へ
 * 分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (コミット c7b1781、PR #552 マージ直後) の hygiene.ts から
 * `grep -oE '^export (class|function|async function|const) [A-Za-z0-9_]+' src/domain/hygiene.ts`
 * および `DEFAULT_HYGIENE_THRESHOLDS` の re-export で機械的に採取した値エクスポート名
 * (9件) をそのままハードコードしている。`export interface` / `export type` は
 * TypeScript の型のみの宣言で実行時のバインディングを持たない (コンパイルで消える) ため
 * `Object.keys()` には現れずこのリストにも含めていない — 型エクスポート面は
 * hygiene-type-export-surface.check.ts が tsc (`npm run build`) で固定する。
 *
 * 分割後の hygiene.ts は名前を明示した re-export (dto.ts と同じ方式。内部専用に
 * export された検出関数まで `export *` で漏らさないため) のみになった。ここが崩れる
 * (関数の移し忘れ・名前の変更・re-export の欠落) と、この一覧との差分としてすぐ
 * 検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'DEFAULT_HYGIENE_THRESHOLDS',
  'STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND',
  'checkHygiene',
  'findDependencyCycles',
  'formatLocalDateKey',
  'hasCloseReasonEvidence',
  'hasLiveWorktreeEvidence',
  'needsCloseEvidenceLookup',
  'pendingDecisionKey',
].sort();

describe('hygiene.ts export surface (bdboard-sso1.15 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split hygiene.ts', () => {
    const actual = Object.keys(hygiene).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
