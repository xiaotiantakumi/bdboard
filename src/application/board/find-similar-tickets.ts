import { findSimilarTickets } from '../../domain/ticket-similarity.js';
import type { Project } from '../../domain/project.js';
import type { Ticket } from '../../domain/ticket.js';
import type { BoardCache } from '../ports/board-cache.js';

export interface SimilarTicketHit {
  readonly ticket: Ticket;
  readonly project: Project;
  readonly score: number;
}

export interface GetSimilarTicketsOptions {
  readonly limit?: number;
}

const DEFAULT_LIMIT = 5;

export function getSimilarTickets(
  cache: BoardCache,
  ticketId: string,
  options?: GetSimilarTicketsOptions,
): readonly SimilarTicketHit[] {
  let target: Ticket | undefined;
  const candidates: Ticket[] = [];
  const projectByTicketId = new Map<string, Project>();

  for (const entry of cache.listProjects()) {
    for (const ticket of entry.tickets) {
      projectByTicketId.set(ticket.id, entry.project);
      if (ticket.id === ticketId) {
        target = ticket;
      }
      candidates.push(ticket);
    }
  }

  if (target === undefined) {
    return [];
  }

  const limit = options?.limit ?? DEFAULT_LIMIT;
  const matches = findSimilarTickets(target, candidates, { limit });

  return matches.map((match) => {
    const project = projectByTicketId.get(match.ticket.id);
    if (project === undefined) {
      throw new Error(`project not found for ticket ${match.ticket.id}`);
    }

    return {
      ticket: match.ticket,
      project,
      score: match.score,
    };
  });
}
