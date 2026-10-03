import { describe, expect, it } from 'vitest';
import * as harnessKpi from './harness-kpi.js';

/**
 * bdboard-sso1.52: src/domain/harness-kpi.ts を関心別モジュール (./harness-kpi/*.ts) へ
 * 分割する際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (このコミット時点) の harness-kpi.ts から
 * `grep -nE '^export (const|function|async function) [A-Za-z0-9_]+' src/domain/harness-kpi.ts`
 * で機械的に採取した値エクスポート名 (14件) をそのままハードコードしている。
 * `export interface` / `export type` は TypeScript の型のみの宣言で実行時のバインディングを
 * 持たない (コンパイルで消える) ため `Object.keys()` には現れずこのリストにも含めていない —
 * 型エクスポート面は harness-kpi-type-export-surface.check.ts が tsc (`npm run build`) で固定する。
 *
 * (bdboard-kuui で createHarnessKpiAccumulator を 1 件足した。分割前の 14 件 + 1 件。)
 *
 * 分割後の harness-kpi.ts は名前を明示した re-export (harness-contract.ts の分割
 * (PR #568) / board.ts の分割 (PR #595) と同じ方式) のみになる。ここが崩れる (関数の
 * 移し忘れ・名前の変更・re-export の欠落) と、この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'PENDING_DECISION_LABEL',
  'PENDING_DECISION_ISSUE_TYPE',
  'HARNESS_LABELS',
  'DUPLICATE_MENTION_PATTERN',
  'RECLAIM_RECLAIM_WINDOW_MS',
  'isPendingDecisionTicket',
  'hasHarnessLabel',
  'mentionsDuplicate',
  'percentileMs',
  'computePendingDecisionDwell',
  'computeReclaimKpi',
  'computeHarnessLabeledShare',
  'computeDuplicateMentionShare',
  'computeHarnessKpi',
  // bdboard-kuui: 分割後に足した値エクスポート (1 回走査版の集計器)。
  'createHarnessKpiAccumulator',
].sort();

describe('harness-kpi.ts export surface (bdboard-sso1.52 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split harness-kpi.ts', () => {
    const actual = Object.keys(harnessKpi).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
