import { compareStrings } from '../../domain/compare.js';
import type { SessionLink } from '../../domain/session.js';
import type { TicketId } from '../../domain/ticket-id.js';
import type { BoardCache } from '../ports/board-cache.js';
import type { ModelUsageTotals } from '../transcript/extract-usage.js';

export interface TicketTokenUsage {
  readonly ticketId: TicketId;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheCreationInputTokens: number;
  readonly totalCacheReadInputTokens: number;
  readonly byModel: readonly ModelUsageTotals[];
}

function buildSessionIdsByTicket(
  links: readonly SessionLink[],
): Map<TicketId, string[]> {
  const index = new Map<TicketId, string[]>();

  for (const link of links) {
    let sessionIds = index.get(link.ticketId);
    if (sessionIds === undefined) {
      sessionIds = [];
      index.set(link.ticketId, sessionIds);
    }
    sessionIds.push(link.sessionId);
  }

  return index;
}

function uniqueSessionIds(sessionIds: readonly string[]): readonly string[] {
  return [...new Set(sessionIds)];
}

function mergeModelUsage(
  items: readonly ModelUsageTotals[],
): readonly ModelUsageTotals[] {
  const byModel = new Map<string, ModelUsageTotals>();

  for (const item of items) {
    const existing = byModel.get(item.model);
    if (existing === undefined) {
      byModel.set(item.model, { ...item });
      continue;
    }

    byModel.set(item.model, {
      model: item.model,
      inputTokens: existing.inputTokens + item.inputTokens,
      outputTokens: existing.outputTokens + item.outputTokens,
      cacheCreationInputTokens:
        existing.cacheCreationInputTokens + item.cacheCreationInputTokens,
      cacheReadInputTokens:
        existing.cacheReadInputTokens + item.cacheReadInputTokens,
    });
  }

  return [...byModel.values()].sort((left, right) =>
    compareStrings(left.model, right.model),
  );
}

export function hasTicketTokenUsage(usage: TicketTokenUsage): boolean {
  return (
    usage.totalInputTokens > 0 ||
    usage.totalOutputTokens > 0 ||
    usage.totalCacheCreationInputTokens > 0 ||
    usage.totalCacheReadInputTokens > 0
  );
}

export function getTicketTokenUsage(
  ticketId: TicketId,
  links: readonly SessionLink[],
  cache: BoardCache,
): TicketTokenUsage {
  const sessionIdsByTicket = buildSessionIdsByTicket(links);
  const sessionIds = uniqueSessionIds(sessionIdsByTicket.get(ticketId) ?? []);
  const byModel = mergeModelUsage(cache.getSessionUsage(sessionIds));

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  let totalCacheReadInputTokens = 0;

  for (const modelUsage of byModel) {
    totalInputTokens += modelUsage.inputTokens;
    totalOutputTokens += modelUsage.outputTokens;
    totalCacheCreationInputTokens += modelUsage.cacheCreationInputTokens;
    totalCacheReadInputTokens += modelUsage.cacheReadInputTokens;
  }

  return {
    ticketId,
    totalInputTokens,
    totalOutputTokens,
    totalCacheCreationInputTokens,
    totalCacheReadInputTokens,
    byModel,
  };
}
