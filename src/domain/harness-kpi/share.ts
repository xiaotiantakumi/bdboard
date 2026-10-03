import type { Ticket } from '../ticket.js';
import { isInRange } from './shared.js';
import {
  DUPLICATE_MENTION_PATTERN,
  HARNESS_LABELS,
  type HarnessKpiRange,
  type HarnessShareKpi,
  type TicketAccumulator,
} from './types.js';

export function hasHarnessLabel(ticket: Ticket): boolean {
  return ticket.labels?.some((label) => HARNESS_LABELS.includes(label)) ?? false;
}

export function mentionsDuplicate(ticket: Ticket): boolean {
  const haystack = `${ticket.title}\n${ticket.description ?? ''}`;
  return DUPLICATE_MENTION_PATTERN.test(haystack);
}

/**
 * 「期間内に作成されたチケットのうち predicate に合うものの割合」の集計器
 * (bdboard-kuui)。母数は期間内作成のチケット (createdAt 基準)。
 */
export function createShareAccumulator(
  range: HarnessKpiRange,
  predicate: (ticket: Ticket) => boolean,
): TicketAccumulator<HarnessShareKpi> {
  let matchedCount = 0;
  let totalCount = 0;

  return {
    add(ticket: Ticket): void {
      if (!isInRange(ticket.createdAt, range)) {
        return;
      }
      totalCount += 1;
      if (predicate(ticket)) {
        matchedCount += 1;
      }
    },

    finish(): HarnessShareKpi {
      return {
        matchedCount,
        totalCount,
        rate: totalCount > 0 ? matchedCount / totalCount : null,
      };
    },
  };
}

function computeShare(
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
  predicate: (ticket: Ticket) => boolean,
): HarnessShareKpi {
  const accumulator = createShareAccumulator(range, predicate);
  for (const ticket of tickets) {
    accumulator.add(ticket);
  }
  return accumulator.finish();
}

export function computeHarnessLabeledShare(
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
): HarnessShareKpi {
  return computeShare(tickets, range, hasHarnessLabel);
}

export function computeDuplicateMentionShare(
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
): HarnessShareKpi {
  return computeShare(tickets, range, mentionsDuplicate);
}
