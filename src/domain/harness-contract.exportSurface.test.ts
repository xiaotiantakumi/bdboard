import { describe, expect, it } from 'vitest';
import * as harnessContract from './harness-contract.js';

/**
 * bdboard-sso1.22: src/domain/harness-contract.ts を関心別モジュール
 * (./harness-contract/*.ts) へ分割する際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (このコミット時点) の harness-contract.ts から
 * `grep -nE '^export (const|function|async function) [A-Za-z0-9_]+' src/domain/harness-contract.ts`
 * で機械的に採取した値エクスポート名 (13件) をそのままハードコードしている。
 * `export interface` / `export type` は TypeScript の型のみの宣言で実行時のバインディングを
 * 持たない (コンパイルで消える) ため `Object.keys()` には現れずこのリストにも含めていない —
 * 型エクスポート面は harness-contract-type-export-surface.check.ts が tsc
 * (`npm run build`) で固定する。
 *
 * 分割後の harness-contract.ts は名前を明示した re-export (hygiene.ts の分割
 * (PR #556) / dto.ts の分割 (PR #540) と同じ方式) のみになる。ここが崩れる
 * (関数の移し忘れ・名前の変更・re-export の欠落) と、この一覧との差分としてすぐ
 * 検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'HARNESS_CONTRACT_RELATIVE_PATH',
  'HARNESS_CONTRACT_VERSION',
  'DEFAULT_MAIN_BRANCH',
  'isSafeMainBranchName',
  'HARNESS_PR_FLOWS',
  'HARNESS_MODEL_COMPLEXITIES',
  'HARNESS_MODEL_WILDCARD',
  'countExpiredModelExcludes',
  'computeModelExclusionWarnings',
  'summarizeHarnessModels',
  'parseHarnessContract',
  'resolveVerifyScriptRequirement',
  'evaluateContractState',
].sort();

describe('harness-contract.ts export surface (bdboard-sso1.22 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split harness-contract.ts', () => {
    const actual = Object.keys(harnessContract).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
