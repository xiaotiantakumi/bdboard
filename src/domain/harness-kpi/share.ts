import type { Ticket } from '../ticket.js';
import { isInRange } from './shared.js';
import {
  DUPLICATE_MENTION_PATTERN,
  HARNESS_LABELS,
  type HarnessKpiRange,
  type HarnessShareKpi,
} from './types.js';

export function hasHarnessLabel(ticket: Ticket): boolean {
  return ticket.labels?.some((label) => HARNESS_LABELS.includes(label)) ?? false;
}

export function mentionsDuplicate(ticket: Ticket): boolean {
  const haystack = `${ticket.title}\n${ticket.description ?? ''}`;
  return DUPLICATE_MENTION_PATTERN.test(haystack);
}

function computeShare(
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
  predicate: (ticket: Ticket) => boolean,
): HarnessShareKpi {
  let matchedCount = 0;
  let totalCount = 0;

  for (const ticket of tickets) {
    if (!isInRange(ticket.createdAt, range)) {
      continue;
    }
    totalCount += 1;
    if (predicate(ticket)) {
      matchedCount += 1;
    }
  }

  return {
    matchedCount,
    totalCount,
    rate: totalCount > 0 ? matchedCount / totalCount : null,
  };
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
