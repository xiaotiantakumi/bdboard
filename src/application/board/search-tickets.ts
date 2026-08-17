import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import type { Ticket } from '../../domain/ticket.js';
import type { BoardCache } from '../ports/board-cache.js';

export interface TicketSearchHit {
  readonly ticket: Ticket;
  readonly project: Project;
}

export interface SearchTicketsOptions {
  readonly query: string;
  readonly limit?: number;
}

const DEFAULT_LIMIT = 30;

type MatchTier = 0 | 1 | 2 | 3 | 4;

interface ScoredHit {
  readonly hit: TicketSearchHit;
  readonly tier: MatchTier;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function parseTerms(query: string): readonly string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => term.toLowerCase());
}

function searchableText(ticket: Ticket): string {
  const parts = [ticket.id, ticket.title];
  if (ticket.description !== undefined) {
    parts.push(ticket.description);
  }
  return parts.join('\n').toLowerCase();
}

function matchesAllTerms(ticket: Ticket, terms: readonly string[]): boolean {
  if (terms.length === 0) {
    return false;
  }

  const haystack = searchableText(ticket);
  return terms.every((term) => haystack.includes(term));
}

function matchTier(ticket: Ticket, normalizedQuery: string): MatchTier {
  const id = ticket.id.toLowerCase();
  const title = ticket.title.toLowerCase();
  const description = ticket.description?.toLowerCase() ?? '';

  if (id === normalizedQuery) {
    return 4;
  }
  if (id.startsWith(normalizedQuery)) {
    return 3;
  }
  if (title.includes(normalizedQuery)) {
    return 2;
  }
  if (description.includes(normalizedQuery)) {
    return 1;
  }
  return 0;
}

function compareHits(a: ScoredHit, b: ScoredHit): number {
  if (a.tier !== b.tier) {
    return b.tier - a.tier;
  }

  if (a.hit.ticket.priority !== b.hit.ticket.priority) {
    return a.hit.ticket.priority - b.hit.ticket.priority;
  }

  const updatedDiff =
    b.hit.ticket.updatedAt.getTime() - a.hit.ticket.updatedAt.getTime();
  if (updatedDiff !== 0) {
    return updatedDiff;
  }

  return compareStrings(a.hit.ticket.id, b.hit.ticket.id);
}

export function searchTickets(
  cache: BoardCache,
  options: SearchTicketsOptions,
): readonly TicketSearchHit[] {
  const normalizedQuery = normalizeQuery(options.query);
  if (normalizedQuery.length === 0) {
    return [];
  }

  const terms = parseTerms(options.query);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const scored: ScoredHit[] = [];

  for (const entry of cache.listProjects()) {
    for (const ticket of entry.tickets) {
      if (!matchesAllTerms(ticket, terms)) {
        continue;
      }

      scored.push({
        hit: {
          ticket,
          project: entry.project,
        },
        tier: matchTier(ticket, normalizedQuery),
      });
    }
  }

  scored.sort(compareHits);
  return scored.slice(0, limit).map((entry) => entry.hit);
}
