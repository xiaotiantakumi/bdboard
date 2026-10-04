// bdboard-ulxa.6: 「並列 7 本で着地予定ツリーの verify のやり直しが減る」をシミュレーションで固定する。
// 実際の verify も CPU 負荷も使わない (verify-slot-sim.mjs の離散時間モデル + 本物の順番決め関数)。
// bdboard-xdk8: landed と pr を同居させない規則 (prOnly、採用) で、着地後検証が pr と同時に走る時間が 0 に
// なり、それでも landed の完全独占 (after、比較用) よりマージ数・最大待ち・やり直しの最大が良いことも固定する。
// このモデルは負荷で verify が遅くなることも偽の failure も表さないので、同居させない損 (待ち) だけが映る —
// ulxa.6 の並び順の効果は、landed も枠を分け合う sharedLanded で見る。
import { describe, expect, it } from 'vitest';

import { POLICIES, simulateSeeds } from './verify-slot-sim.mjs';

const SEEDS = [1, 2, 3, 4];

describe('verify slot simulation (7 agents, 2 slots)', () => {
  const before = simulateSeeds(POLICIES.before, SEEDS);
  const ordered = simulateSeeds(POLICIES.sharedLanded, SEEDS);
  const after = simulateSeeds(POLICIES.after, SEEDS);
  const adopted = simulateSeeds(POLICIES.prOnly, SEEDS);

  it('cuts wasted predicted-verify runs per merge and the worst-case redo count (ulxa.6 ordering)', () => {
    expect(ordered.wastedPerMerge).toBeLessThanOrEqual(before.wastedPerMerge * 0.6);
    expect(ordered.redoMean).toBeLessThan(before.redoMean);
    expect(ordered.redoMax).toBeLessThan(before.redoMax);
    expect(ordered.merges).toBeGreaterThan(before.merges);
  });

  it('keeps pre-PR verify waits bounded while merge runs go first', () => {
    // 下位 (pr) も有限の時間で順番が来る (抜けるのは後から 8〜14 分以内に並んだ上位だけ)。
    expect(ordered.prWaitMaxMin).toBeLessThan(30);
    expect(after.prWaitMaxMin).toBeLessThan(30);
    expect(adopted.prWaitMaxMin).toBeLessThan(30);
  });

  it('never runs the landed verify beside a pr verify once landed excludes pr (bdboard-xdk8), and keeps the ordering gains', () => {
    expect(ordered.landedBesidePrMin).toBeGreaterThan(0);
    expect(adopted.landedBesidePrMin).toBe(0);
    expect(adopted.landedSharedMin).toBeGreaterThan(0); // merge とは枠を分け合う
    expect(adopted.wastedPerMerge).toBeLessThanOrEqual(before.wastedPerMerge * 0.6);
    expect(adopted.merges).toBeGreaterThan(before.merges);
  });

  it('costs far less than running the landed verify alone (merges, worst merge latency, worst redo count)', () => {
    expect(after.landedSharedMin).toBe(0);
    expect(adopted.merges).toBeGreaterThan(after.merges * 1.3);
    expect(adopted.latencyMaxMin).toBeLessThan(after.latencyMaxMin / 2);
    expect(adopted.redoMax).toBeLessThan(after.redoMax);
  });

  it('never runs more than the slot limit under any policy', () => {
    for (const policy of Object.values(POLICIES)) {
      expect(simulateSeeds(policy, [1, 2]).maxRunning).toBeLessThanOrEqual(2);
    }
  });
});
