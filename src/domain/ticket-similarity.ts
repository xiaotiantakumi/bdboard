import { compareStrings } from './compare.js';
import type { Ticket } from './ticket.js';

const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_SCORE = 0.1;
const TITLE_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 1;

function tokenize(text: string): Set<string> {
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => term.toLowerCase());
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }

  const union = a.size + b.size - intersection;
  if (union === 0) {
    return 0;
  }

  return intersection / union;
}

function titleTokens(ticket: Ticket): Set<string> {
  return tokenize(ticket.title);
}

function descriptionTokens(ticket: Ticket): Set<string> {
  return tokenize(ticket.description ?? '');
}

export function computeTicketSimilarity(target: Ticket, candidate: Ticket): number {
  const titleScore = jaccard(titleTokens(target), titleTokens(candidate));
  const descriptionScore = jaccard(
    descriptionTokens(target),
    descriptionTokens(candidate),
  );
  const totalWeight = TITLE_WEIGHT + DESCRIPTION_WEIGHT;
  return (TITLE_WEIGHT * titleScore + DESCRIPTION_WEIGHT * descriptionScore) / totalWeight;
}

export interface SimilarTicketMatch {
  readonly ticket: Ticket;
  readonly score: number;
}

export interface FindSimilarTicketsOptions {
  readonly limit?: number;
  readonly minScore?: number;
}

export function findSimilarTickets(
  target: Ticket,
  candidates: readonly Ticket[],
  options?: FindSimilarTicketsOptions,
): readonly SimilarTicketMatch[] {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
  const scored: SimilarTicketMatch[] = [];

  for (const candidate of candidates) {
    if (candidate.id === target.id) {
      continue;
    }

    const score = computeTicketSimilarity(target, candidate);
    if (score < minScore) {
      continue;
    }

    scored.push({ ticket: candidate, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return compareStrings(a.ticket.id, b.ticket.id);
  });

  return scored.slice(0, limit);
}
