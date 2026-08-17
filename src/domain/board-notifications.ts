import { createReadinessContext, isReady } from './readiness.js';
import type { AgentSession } from './session.js';
import type { Ticket } from './ticket.js';
import type { TicketId } from './ticket-id.js';

export interface BoardNotificationSnapshot {
  readonly readyTicketIds: ReadonlySet<TicketId>;
  readonly decisionPendingTicketIds: ReadonlySet<TicketId>;
}

export interface BoardSnapshotProjectInput {
  readonly tickets: readonly Ticket[];
  readonly decisionPendingTicketIds?: readonly TicketId[];
}

export function computeBoardNotificationSnapshot(
  projects: readonly BoardSnapshotProjectInput[],
  now: Date,
): BoardNotificationSnapshot {
  const readyTicketIds = new Set<TicketId>();
  const decisionPendingTicketIds = new Set<TicketId>();

  for (const project of projects) {
    const ctx = createReadinessContext(project.tickets);
    for (const ticket of project.tickets) {
      if (isReady(ticket, ctx, now)) {
        readyTicketIds.add(ticket.id);
      }
    }

    if (project.decisionPendingTicketIds !== undefined) {
      for (const ticketId of project.decisionPendingTicketIds) {
        decisionPendingTicketIds.add(ticketId);
      }
    }
  }

  return { readyTicketIds, decisionPendingTicketIds };
}

export type BoardTransitionEvent =
  | { readonly kind: 'ticket_ready'; readonly ticketId: TicketId }
  | { readonly kind: 'decision_pending'; readonly ticketId: TicketId };

export function diffBoardNotificationSnapshots(
  prev: BoardNotificationSnapshot,
  next: BoardNotificationSnapshot,
): readonly BoardTransitionEvent[] {
  const events: BoardTransitionEvent[] = [];

  for (const ticketId of next.readyTicketIds) {
    if (!prev.readyTicketIds.has(ticketId)) {
      events.push({ kind: 'ticket_ready', ticketId });
    }
  }

  for (const ticketId of next.decisionPendingTicketIds) {
    if (!prev.decisionPendingTicketIds.has(ticketId)) {
      events.push({ kind: 'decision_pending', ticketId });
    }
  }

  return events;
}

export interface SessionDiedEvent {
  readonly kind: 'session_died';
  readonly sessionId: string;
  readonly cwd: string;
  readonly name?: string;
  readonly lastActivityAt: Date;
}

export function diffSessionLiveness(
  prev: readonly AgentSession[],
  next: readonly AgentSession[],
): readonly SessionDiedEvent[] {
  const prevById = new Map(prev.map((session) => [session.sessionId, session]));
  const events: SessionDiedEvent[] = [];

  for (const session of next) {
    const prevSession = prevById.get(session.sessionId);
    if (
      prevSession !== undefined &&
      prevSession.alive &&
      !session.alive
    ) {
      events.push({
        kind: 'session_died',
        sessionId: session.sessionId,
        cwd: session.cwd,
        ...(session.name !== undefined ? { name: session.name } : {}),
        lastActivityAt: session.lastActivityAt,
      });
    }
  }

  return events;
}
