import type { Ticket } from '../ticket.js';
import { percentileMs } from './percentile.js';
import { isInRange } from './shared.js';
import {
  PENDING_DECISION_ISSUE_TYPE,
  PENDING_DECISION_LABEL,
  type HarnessKpiRange,
  type PendingDecisionDwellKpi,
} from './types.js';

export function isPendingDecisionTicket(ticket: Ticket): boolean {
  if (ticket.issueType === PENDING_DECISION_ISSUE_TYPE) {
    return true;
  }
  return ticket.labels?.includes(PENDING_DECISION_LABEL) ?? false;
}

export function computePendingDecisionDwell(
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
): PendingDecisionDwellKpi {
  const durations: number[] = [];
  let closedGateCount = 0;
  let closedWorkCount = 0;
  let openCount = 0;
  let openGateCount = 0;
  let openWorkCount = 0;

  for (const ticket of tickets) {
    if (!isPendingDecisionTicket(ticket)) {
      continue;
    }
    const isGate = ticket.issueType === PENDING_DECISION_ISSUE_TYPE;

    if (ticket.closedAt === undefined) {
      openCount += 1;
      if (isGate) {
        openGateCount += 1;
      } else {
        openWorkCount += 1;
      }
      continue;
    }

    if (!isInRange(ticket.closedAt, range)) {
      continue;
    }

    if (isGate) {
      closedGateCount += 1;
    } else {
      closedWorkCount += 1;
    }

    // ラベル付与時刻は bd から取れないので作成時刻を起点にする (anchor: 'created')。
    // close が作成より前になることは無いはずだが、時計のずれで負にならないよう 0 で切る。
    durations.push(Math.max(0, ticket.closedAt.getTime() - ticket.createdAt.getTime()));
  }

  durations.sort((a, b) => a - b);

  return {
    closedCount: durations.length,
    closedGateCount,
    closedWorkCount,
    openCount,
    openGateCount,
    openWorkCount,
    medianMs: percentileMs(durations, 0.5),
    p90Ms: percentileMs(durations, 0.9),
    anchor: 'created',
  };
}
