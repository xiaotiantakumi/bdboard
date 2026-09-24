// bdboard-ulxa.6: 「並列 7 本で着地予定ツリーの verify のやり直しが減る」をシミュレーションで固定する。
// 実際の verify も CPU 負荷も使わない (verify-slot-sim.mjs の離散時間モデル + 本物の順番決め関数)。
import { describe, expect, it } from 'vitest';

import { POLICIES, simulateSeeds } from './verify-slot-sim.mjs';

const SEEDS = [1, 2, 3, 4];

describe('verify slot simulation (7 agents, 2 slots)', () => {
  const before = simulateSeeds(POLICIES.before, SEEDS);
  const after = simulateSeeds(POLICIES.after, SEEDS);

  it('cuts wasted predicted-verify runs per merge and the worst-case redo count', () => {
    expect(after.wastedPerMerge).toBeLessThanOrEqual(before.wastedPerMerge * 0.6);
    expect(after.redoMean).toBeLessThan(before.redoMean);
    expect(after.redoMax).toBeLessThan(before.redoMax);
    expect(after.merges).toBeGreaterThan(before.merges);
  });

  it('keeps pre-PR verify waits bounded while merge runs go first', () => {
    // 下位 (pr) の待ちの上限 = FIFO の待ち + 2 段 × tierStepMs 程度。30 分 (stale) には届かない。
    expect(after.prWaitMaxMin).toBeLessThan(30);
  });

  it('never runs more than the slot limit under any policy', () => {
    for (const policy of Object.values(POLICIES)) {
      expect(simulateSeeds(policy, [1, 2]).maxRunning).toBeLessThanOrEqual(2);
    }
  });
});
