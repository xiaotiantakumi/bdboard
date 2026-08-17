import type { CachedProject } from '../ports/board-cache.js';
import {
  diffBoardNotificationSnapshots,
  type BoardNotificationSnapshot,
  type SessionDiedEvent,
} from '../../domain/board-notifications.js';

export interface BoardNotificationPayload {
  readonly kind: 'ticket_ready' | 'decision_pending';
  readonly ticketId: string;
  readonly title?: string;
  readonly projectId?: string;
  readonly occurredAt: string;
}

export interface SessionDiedNotificationPayload {
  readonly kind: 'session_died';
  readonly sessionId: string;
  readonly cwd: string;
  readonly name?: string;
  readonly lastActivityAt: string;
  readonly occurredAt: string;
}

export function findTicketMeta(
  entries: readonly CachedProject[],
  ticketId: string,
): { title: string; projectId: string } | undefined {
  for (const entry of entries) {
    const ticket = entry.tickets.find((candidate) => candidate.id === ticketId);
    if (ticket !== undefined) {
      return { title: ticket.title, projectId: ticket.projectId };
    }
  }
  return undefined;
}

export function buildBoardNotificationPayload(
  transition: { readonly kind: 'ticket_ready' | 'decision_pending'; readonly ticketId: string },
  meta: { title: string; projectId: string } | undefined,
  occurredAt: Date,
): BoardNotificationPayload {
  return {
    kind: transition.kind,
    ticketId: transition.ticketId,
    ...(meta !== undefined ? { title: meta.title, projectId: meta.projectId } : {}),
    occurredAt: occurredAt.toISOString(),
  };
}

export function buildSessionDiedNotificationPayload(
  diedEvent: SessionDiedEvent,
  occurredAt: Date,
): SessionDiedNotificationPayload {
  return {
    kind: 'session_died',
    sessionId: diedEvent.sessionId,
    cwd: diedEvent.cwd,
    ...(diedEvent.name !== undefined ? { name: diedEvent.name } : {}),
    lastActivityAt: diedEvent.lastActivityAt.toISOString(),
    occurredAt: occurredAt.toISOString(),
  };
}

export interface BoardNotificationPublisher {
  /**
   * 起動時の初回スナップショットを prior state として確立する。
   * 差分通知は発行しない。
   */
  seedSnapshot(snapshot: BoardNotificationSnapshot): void;
  /**
   * 前回スナップショットとの差分から通知ペイロードを組み立てる。
   * prior state が未確立の初回呼び出しではスナップショットを確立するだけで空配列を返す。
   */
  collectTransitions(
    entries: readonly CachedProject[],
    nextSnapshot: BoardNotificationSnapshot,
    occurredAt: Date,
  ): readonly BoardNotificationPayload[];
}

export function createBoardNotificationPublisher(): BoardNotificationPublisher {
  let previousBoardNotificationSnapshot: BoardNotificationSnapshot | null = null;

  return {
    seedSnapshot(snapshot: BoardNotificationSnapshot): void {
      previousBoardNotificationSnapshot = snapshot;
    },

    collectTransitions(
      entries: readonly CachedProject[],
      nextSnapshot: BoardNotificationSnapshot,
      occurredAt: Date,
    ): readonly BoardNotificationPayload[] {
      if (previousBoardNotificationSnapshot === null) {
        previousBoardNotificationSnapshot = nextSnapshot;
        return [];
      }

      const transitions = diffBoardNotificationSnapshots(
        previousBoardNotificationSnapshot,
        nextSnapshot,
      );

      const payloads = transitions.map((transition) =>
        buildBoardNotificationPayload(
          transition,
          findTicketMeta(entries, transition.ticketId),
          occurredAt,
        ),
      );

      previousBoardNotificationSnapshot = nextSnapshot;
      return payloads;
    },
  };
}
