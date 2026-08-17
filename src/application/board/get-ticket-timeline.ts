import type { InteractionRecord } from '../../domain/interaction.js';
import type { BoardCache } from '../ports/board-cache.js';
import {
  compareEvents,
  closestRecord,
  enrichFromRecord,
  interactionEvent,
  type ActivityEvent,
  type TicketContext,
} from './activity-events.js';

export interface GetTicketTimelineOptions {
  readonly limit?: number;
}

const DEFAULT_LIMIT = 200;

export function getTicketTimeline(
  cache: BoardCache,
  ticketId: string,
  options?: GetTicketTimelineOptions,
): readonly ActivityEvent[] {
  let context: TicketContext | undefined;

  for (const entry of cache.listProjects()) {
    const ticket = entry.tickets.find((candidate) => candidate.id === ticketId);
    if (ticket !== undefined) {
      context = { ticket, project: entry.project };
      break;
    }
  }

  if (context === undefined) {
    return [];
  }

  const events: ActivityEvent[] = [];

  events.push({
    kind: 'created',
    at: context.ticket.createdAt,
    ticket: context.ticket,
    project: context.project,
  });

  if (context.ticket.startedAt !== undefined) {
    events.push({
      kind: 'started',
      at: context.ticket.startedAt,
      ticket: context.ticket,
      project: context.project,
    });
  }

  if (context.ticket.closedAt !== undefined) {
    events.push({
      kind: 'closed',
      at: context.ticket.closedAt,
      ticket: context.ticket,
      project: context.project,
    });
  }

  const interactions = cache
    .listInteractions()
    .filter((record) => record.ticketId === ticketId);
  const usedInteractionIds = new Set<string>();

  const statusClosedRecords: InteractionRecord[] = [];
  const statusStartedRecords: InteractionRecord[] = [];

  for (const record of interactions) {
    if (record.field === 'status' && record.newValue === 'closed') {
      statusClosedRecords.push(record);
      continue;
    }

    if (record.field === 'status' && record.newValue === 'in_progress') {
      statusStartedRecords.push(record);
    }
  }

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }

    if (event.kind === 'closed') {
      const record = closestRecord(event.at, statusClosedRecords);
      if (record !== undefined) {
        events[index] = enrichFromRecord(event, record);
        usedInteractionIds.add(record.id);
      }
      continue;
    }

    if (event.kind === 'started') {
      const record = closestRecord(event.at, statusStartedRecords);
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

  const limit = options?.limit ?? DEFAULT_LIMIT;
  events.sort(compareEvents);
  return events.slice(0, limit);
}
