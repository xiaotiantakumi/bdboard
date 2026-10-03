import type { Ticket } from '../ticket.js';
import { createPendingDecisionAccumulator } from './pending-decision.js';
import { createReclaimAccumulator } from './reclaim.js';
import {
  createShareAccumulator,
  hasHarnessLabel,
  mentionsDuplicate,
} from './share.js';
import {
  RECLAIM_RECLAIM_WINDOW_MS,
  type ComputeHarnessKpiInput,
  type HarnessKpi,
  type HarnessKpiAccumulator,
  type HarnessKpiAccumulatorInput,
} from './types.js';

/**
 * 4 指標を 1 回の add で同時に集計する集計器 (bdboard-kuui)。
 *
 * 以前の computeHarnessKpi は全チケットを 4 回 (確認待ち滞留・reclaim の突き合わせ用
 * インデックス・harness 起票率・重複言及率) 同期で走査しており、数十万件でイベント
 * ループを数百 ms 塞いでいた。この集計器は add(ticket) を呼ぶだけなので、application
 * 層が forEachChunked 越しに回してチャンクごとにイベントループへ制御を返せる。
 * ドメインは yield を知らない (純粋なまま)。
 *
 * 結果は 4 回走査版と同一 (aggregate.equivalence.test.ts が旧実装の写しと突き合わせる)。
 */
export function createHarnessKpiAccumulator(
  input: HarnessKpiAccumulatorInput,
): HarnessKpiAccumulator {
  const { range } = input;
  const pendingDecisionDwell = createPendingDecisionAccumulator(range);
  const reclaim = createReclaimAccumulator(
    input.reclaimRuns ?? [],
    range,
    input.reclaimWindowMs ?? RECLAIM_RECLAIM_WINDOW_MS,
    input.leftoverCandidates ?? [],
  );
  const harnessLabeled = createShareAccumulator(range, hasHarnessLabel);
  const duplicateMention = createShareAccumulator(range, mentionsDuplicate);

  return {
    add(ticket: Ticket): void {
      pendingDecisionDwell.add(ticket);
      reclaim.add(ticket);
      harnessLabeled.add(ticket);
      duplicateMention.add(ticket);
    },

    finish(): HarnessKpi {
      return {
        rangeStart: range.start,
        rangeEnd: range.end,
        pendingDecisionDwell: pendingDecisionDwell.finish(),
        reclaim: reclaim.finish(),
        harnessLabeled: harnessLabeled.finish(),
        duplicateMention: duplicateMention.finish(),
      };
    },
  };
}

export function computeHarnessKpi(input: ComputeHarnessKpiInput): HarnessKpi {
  const { tickets, ...rest } = input;
  const accumulator = createHarnessKpiAccumulator(rest);
  for (const ticket of tickets) {
    accumulator.add(ticket);
  }
  return accumulator.finish();
}
