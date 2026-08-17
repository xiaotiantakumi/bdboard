import type { InteractionRecord } from '../../domain/interaction.js';
import type { BoardCache } from '../ports/board-cache.js';
import {
  compareEvents,
  closestRecord,
  enrichFromRecord,
  interactionEvent,
  isInWindow,
  type ActivityEvent,
  type TicketContext,
} from './activity-events.js';

export type { ActivityEventKind, ActivityEvent } from './activity-events.js';

export interface GetActivityFeedOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
  readonly windowDays?: number;
  readonly limit?: number;
}

const DEFAULT_WINDOW_DAYS = 1;
const DEFAULT_LIMIT = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function windowStart(now: Date, windowDays: number): Date {
  return new Date(now.getTime() - windowDays * MS_PER_DAY);
}

export function getActivityFeed(
  cache: BoardCache,
  now: Date,
  options?: GetActivityFeedOptions,
): readonly ActivityEvent[] {
  const windowDays = options?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const projectIdFilter = options?.projectIds;
  const start = windowStart(now, windowDays);
  const events: ActivityEvent[] = [];
  const ticketById = new Map<string, TicketContext>();

  let entries = cache.listProjects();
  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  for (const entry of entries) {
    for (const ticket of entry.tickets) {
      ticketById.set(ticket.id, { ticket, project: entry.project });

      if (isInWindow(ticket.createdAt, start, now)) {
        events.push({
          kind: 'created',
          at: ticket.createdAt,
          ticket,
          project: entry.project,
        });
      }

      if (
        ticket.startedAt !== undefined &&
        isInWindow(ticket.startedAt, start, now)
      ) {
        events.push({
          kind: 'started',
          at: ticket.startedAt,
          ticket,
          project: entry.project,
        });
      }

      if (
        ticket.closedAt !== undefined &&
        isInWindow(ticket.closedAt, start, now)
      ) {
        events.push({
          kind: 'closed',
          at: ticket.closedAt,
          ticket,
          project: entry.project,
        });
      }
    }
  }

  const interactions = cache.listInteractions({ since: start });
  const usedInteractionIds = new Set<string>();

  const statusClosedByTicket = new Map<string, InteractionRecord[]>();
  const statusStartedByTicket = new Map<string, InteractionRecord[]>();

  for (const record of interactions) {
    if (!isInWindow(record.at, start, now)) {
      continue;
    }

    const context = ticketById.get(record.ticketId);
    if (context === undefined) {
      continue;
    }

    if (record.field === 'status' && record.newValue === 'closed') {
      const bucket = statusClosedByTicket.get(record.ticketId) ?? [];
      bucket.push(record);
      statusClosedByTicket.set(record.ticketId, bucket);
      continue;
    }

    if (record.field === 'status' && record.newValue === 'in_progress') {
      const bucket = statusStartedByTicket.get(record.ticketId) ?? [];
      bucket.push(record);
      statusStartedByTicket.set(record.ticketId, bucket);
    }
  }

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }

    if (event.kind === 'closed') {
      const candidates = statusClosedByTicket.get(event.ticket.id);
      const record = candidates === undefined ? undefined : closestRecord(event.at, candidates);
      if (record !== undefined) {
        events[index] = enrichFromRecord(event, record);
        usedInteractionIds.add(record.id);
      }
      continue;
    }

    if (event.kind === 'started') {
      const candidates = statusStartedByTicket.get(event.ticket.id);
      const record = candidates === undefined ? undefined : closestRecord(event.at, candidates);
      if (record !== undefined) {
        events[index] = enrichFromRecord(event, record);
        usedInteractionIds.add(record.id);
      }
    }
  }

  for (const record of interactions) {
    if (usedInteractionIds.has(record.id)) {
      continue;
    }
    if (!isInWindow(record.at, start, now)) {
      continue;
    }

    const context = ticketById.get(record.ticketId);
    if (context === undefined) {
      continue;
    }

    if (record.field === 'status') {
      events.push(interactionEvent('status_changed', record, context));
      continue;
    }

    if (record.field === 'priority') {
      events.push(interactionEvent('priority_changed', record, context));
      continue;
    }

    events.push(interactionEvent('field_changed', record, context));
  }

  events.sort(compareEvents);
  return events.slice(0, limit);
}
