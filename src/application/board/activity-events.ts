import { compareStrings } from '../../domain/compare.js';
import type { InteractionRecord } from '../../domain/interaction.js';
import type { Project } from '../../domain/project.js';
import type { Ticket } from '../../domain/ticket.js';

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

export interface TicketContext {
  readonly ticket: Ticket;
  readonly project: Project;
}

export function isInWindow(at: Date, start: Date, end: Date): boolean {
  const timestamp = at.getTime();
  return timestamp >= start.getTime() && timestamp <= end.getTime();
}

export function compareEvents(a: ActivityEvent, b: ActivityEvent): number {
  const atDiff = b.at.getTime() - a.at.getTime();
  if (atDiff !== 0) {
    return atDiff;
  }

  return compareStrings(a.ticket.id, b.ticket.id);
}

export function closestRecord(
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

export function enrichFromRecord(
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

export function interactionEvent(
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
