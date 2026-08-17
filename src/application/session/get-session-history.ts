import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import type { AgentSession, SessionLink } from '../../domain/session.js';
import type { TicketId } from '../../domain/ticket-id.js';
import type { BoardCache } from '../ports/board-cache.js';
import { resolveSessionProject } from './link-sessions-to-projects.js';

export interface SessionHistoryTicketRef {
  readonly ticketId: TicketId;
  readonly title?: string;
}

export interface SessionHistoryEntry {
  readonly session: AgentSession;
  readonly project?: Project;
  readonly tickets: readonly SessionHistoryTicketRef[];
}

export interface GetSessionHistoryOptions {
  readonly limit?: number;
}

const DEFAULT_LIMIT = 50;

function compareHistoryEntries(a: SessionHistoryEntry, b: SessionHistoryEntry): number {
  const atDiff = b.session.lastActivityAt.getTime() - a.session.lastActivityAt.getTime();
  if (atDiff !== 0) {
    return atDiff;
  }

  return compareStrings(a.session.sessionId, b.session.sessionId);
}

function buildTicketTitleMap(cache: BoardCache): ReadonlyMap<TicketId, string> {
  const map = new Map<TicketId, string>();

  for (const entry of cache.listProjects()) {
    for (const ticket of entry.tickets) {
      map.set(ticket.id, ticket.title);
    }
  }

  return map;
}

function ticketsForSession(
  sessionId: string,
  links: readonly SessionLink[],
  ticketTitles: ReadonlyMap<TicketId, string>,
): readonly SessionHistoryTicketRef[] {
  const ticketIds = new Set<TicketId>();

  for (const link of links) {
    if (link.sessionId !== sessionId) {
      continue;
    }
    ticketIds.add(link.ticketId);
  }

  const sortedIds = [...ticketIds].sort(compareStrings);
  const tickets: SessionHistoryTicketRef[] = [];

  for (const ticketId of sortedIds) {
    const title = ticketTitles.get(ticketId);
    tickets.push(
      title !== undefined ? { ticketId, title } : { ticketId },
    );
  }

  return tickets;
}

export function getSessionHistory(
  sessions: readonly AgentSession[],
  links: readonly SessionLink[],
  cache: BoardCache,
  options?: GetSessionHistoryOptions,
): readonly SessionHistoryEntry[] {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) {
    return [];
  }

  const projects = cache.listProjects().map((entry) => entry.project);
  const ticketTitles = buildTicketTitleMap(cache);

  const endedSessions = sessions.filter((session) => session.alive === false);
  const entries: SessionHistoryEntry[] = [];

  for (const session of endedSessions) {
    const project = resolveSessionProject(session.cwd, projects);
    const tickets = ticketsForSession(session.sessionId, links, ticketTitles);

    entries.push({
      session,
      tickets,
      ...(project !== undefined ? { project } : {}),
    });
  }

  entries.sort(compareHistoryEntries);
  return entries.slice(0, limit);
}
