import { compareStrings } from '../../domain/compare.js';
import type { InteractionRecord } from '../../domain/interaction.js';
import type { Project } from '../../domain/project.js';
import type { Ticket } from '../../domain/ticket.js';
import type { BoardCache } from '../ports/board-cache.js';

export type ActivityEventKind =
  | 'created'
  | 'started'
  | 'closed'
  | 'status_changed'
  | 'priority_changed'
  | 'field_changed';

export interface ActivityEvent {
  readonly kind: ActivityEventKind;
  readonly at: Date;
  readonly ticket: Ticket;
  readonly project: Project;
  readonly actor?: string;
  readonly reason?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface GetActivityFeedOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
  readonly windowDays?: number;
  readonly limit?: number;
}

const DEFAULT_WINDOW_DAYS = 1;
const DEFAULT_LIMIT = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface TicketContext {
  readonly ticket: Ticket;
  readonly project: Project;
}

function windowStart(now: Date, windowDays: number): Date {
  return new Date(now.getTime() - windowDays * MS_PER_DAY);
}

function isInWindow(at: Date, start: Date, end: Date): boolean {
  const timestamp = at.getTime();
  return timestamp >= start.getTime() && timestamp <= end.getTime();
}

function compareEvents(a: ActivityEvent, b: ActivityEvent): number {
  const atDiff = b.at.getTime() - a.at.getTime();
  if (atDiff !== 0) {
    return atDiff;
  }

  return compareStrings(a.ticket.id, b.ticket.id);
}

function closestRecord(
  eventAt: Date,
  records: readonly InteractionRecord[],
): InteractionRecord | undefined {
  if (records.length === 0) {
    return undefined;
  }

  let closest = records[0];
  let closestDistance = Math.abs(closest.at.getTime() - eventAt.getTime());

  for (let index = 1; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) {
      continue;
    }
    const distance = Math.abs(record.at.getTime() - eventAt.getTime());
    if (distance < closestDistance) {
      closest = record;
      closestDistance = distance;
    }
  }

  return closest;
}

function enrichFromRecord(
  event: ActivityEvent,
  record: InteractionRecord,
): ActivityEvent {
  return {
    ...event,
    actor: record.actor,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.oldValue !== undefined ? { from: record.oldValue } : {}),
    ...(record.newValue !== undefined ? { to: record.newValue } : {}),
  };
}

function interactionEvent(
  kind: 'status_changed' | 'priority_changed' | 'field_changed',
  record: InteractionRecord,
  context: TicketContext,
): ActivityEvent {
  return {
    kind,
    at: record.at,
    ticket: context.ticket,
    project: context.project,
    actor: record.actor,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.oldValue !== undefined ? { from: record.oldValue } : {}),
    ...(record.newValue !== undefined ? { to: record.newValue } : {}),
  };
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
