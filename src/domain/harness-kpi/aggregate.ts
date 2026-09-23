import { computePendingDecisionDwell } from './pending-decision.js';
import { computeReclaimKpi } from './reclaim.js';
import { computeDuplicateMentionShare, computeHarnessLabeledShare } from './share.js';
import {
  RECLAIM_RECLAIM_WINDOW_MS,
  type ComputeHarnessKpiInput,
  type HarnessKpi,
} from './types.js';

export function computeHarnessKpi(input: ComputeHarnessKpiInput): HarnessKpi {
  const { tickets, range } = input;

  return {
    rangeStart: range.start,
    rangeEnd: range.end,
    pendingDecisionDwell: computePendingDecisionDwell(tickets, range),
    reclaim: computeReclaimKpi(
      input.reclaimRuns ?? [],
      tickets,
      range,
      input.reclaimWindowMs ?? RECLAIM_RECLAIM_WINDOW_MS,
      input.leftoverCandidates ?? [],
    ),
    harnessLabeled: computeHarnessLabeledShare(tickets, range),
    duplicateMention: computeDuplicateMentionShare(tickets, range),
  };
}
