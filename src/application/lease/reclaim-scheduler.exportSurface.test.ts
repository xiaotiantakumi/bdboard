import { describe, expect, it } from 'vitest';
import * as reclaimScheduler from './reclaim-scheduler.js';

/**
 * bdboard-sso1.51: src/application/lease/reclaim-scheduler.ts を関心別モジュール
 * (./reclaim-scheduler/*.ts) へ分割する際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (このコミット時点) の reclaim-scheduler.ts から
 * `grep -nE '^export (const|function|async function) [A-Za-z0-9_]+' src/application/lease/reclaim-scheduler.ts`
 * で機械的に採取した値エクスポート名 (6件) をそのままハードコードしている。
 * `export interface` / `export type` は TypeScript の型のみの宣言で実行時のバインディングを
 * 持たない (コンパイルで消える) ため `Object.keys()` には現れずこのリストにも含めていない —
 * 型エクスポート面は reclaim-scheduler-type-export-surface.check.ts が tsc (`npm run build`) で
 * 固定する。
 *
 * 分割後の reclaim-scheduler.ts は名前を明示した re-export (board.ts の分割
 * (PR #595) / harness-contract.ts の分割 (PR #568) / dto.ts の分割 (PR #540) と同じ方式)
 * のみになる。ここが崩れる (関数の移し忘れ・名前の変更・re-export の欠落) と、この一覧との
 * 差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'DEFAULT_RECLAIM_INTERVAL_MS',
  'DEFAULT_RECLAIM_OLDER_THAN',
  'MIN_SAFE_RECLAIM_OLDER_THAN_MS',
  'parseReclaimDurationMs',
  'describeReclaimSkip',
  'createReclaimScheduler',
].sort();

describe('reclaim-scheduler.ts export surface (bdboard-sso1.51 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split reclaim-scheduler.ts', () => {
    const actual = Object.keys(reclaimScheduler).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
