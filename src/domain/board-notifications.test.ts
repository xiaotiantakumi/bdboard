import { describe, expect, it } from 'vitest';
import {
  computeBoardNotificationSnapshot,
  diffBoardNotificationSnapshots,
  diffSessionLiveness,
  type BoardNotificationSnapshot,
} from './board-notifications.js';
import { makeSession, makeTicket } from './test-support.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function blocksEdge(issueId: string, dependsOnId: string) {
  return { issueId, dependsOnId, kind: 'blocks' as const };
}

describe('computeBoardNotificationSnapshot', () => {
  it('includes open unblocked tickets in readyTicketIds', () => {
    const readyTicket = makeTicket({ id: 'bdboard-ready', status: 'open' });
    const snapshot = computeBoardNotificationSnapshot(
      [{ tickets: [readyTicket] }],
      NOW,
    );

    expect([...snapshot.readyTicketIds]).toEqual(['bdboard-ready']);
  });

  it('excludes blocked tickets from readyTicketIds', () => {
    const blocker = makeTicket({ id: 'bdboard-blocker', status: 'open' });
    const blocked = makeTicket({
      id: 'bdboard-blocked',
      status: 'open',
      dependencies: [blocksEdge('bdboard-blocked', 'bdboard-blocker')],
    });
    const snapshot = computeBoardNotificationSnapshot(
      [{ tickets: [blocker, blocked] }],
      NOW,
    );

    expect([...snapshot.readyTicketIds]).toEqual(['bdboard-blocker']);
  });

  it('collects decisionPendingTicketIds from project input', () => {
    const snapshot = computeBoardNotificationSnapshot(
      [
        {
          tickets: [],
          decisionPendingTicketIds: ['bdboard-a', 'bdboard-b'],
        },
      ],
      NOW,
    );

    expect([...snapshot.decisionPendingTicketIds]).toEqual([
      'bdboard-a',
      'bdboard-b',
    ]);
  });
});

describe('diffBoardNotificationSnapshots', () => {
  it('emits ticket_ready only for ids newly present in next.readyTicketIds', () => {
    const prev: BoardNotificationSnapshot = {
      readyTicketIds: new Set(['bdboard-a']),
      decisionPendingTicketIds: new Set(),
    };
    const next: BoardNotificationSnapshot = {
      readyTicketIds: new Set(['bdboard-a', 'bdboard-b']),
      decisionPendingTicketIds: new Set(),
    };

    expect(diffBoardNotificationSnapshots(prev, next)).toEqual([
      { kind: 'ticket_ready', ticketId: 'bdboard-b' },
    ]);
  });

  it('emits decision_pending only for ids newly present in next.decisionPendingTicketIds', () => {
    const prev: BoardNotificationSnapshot = {
      readyTicketIds: new Set(),
      decisionPendingTicketIds: new Set(['bdboard-a']),
    };
    const next: BoardNotificationSnapshot = {
      readyTicketIds: new Set(),
      decisionPendingTicketIds: new Set(['bdboard-a', 'bdboard-b']),
    };

    expect(diffBoardNotificationSnapshots(prev, next)).toEqual([
      { kind: 'decision_pending', ticketId: 'bdboard-b' },
    ]);
  });

  it('does not re-notify ids present in both snapshots', () => {
    const prev: BoardNotificationSnapshot = {
      readyTicketIds: new Set(['bdboard-a']),
      decisionPendingTicketIds: new Set(['bdboard-x']),
    };
    const next: BoardNotificationSnapshot = {
      readyTicketIds: new Set(['bdboard-a']),
      decisionPendingTicketIds: new Set(['bdboard-x']),
    };

    expect(diffBoardNotificationSnapshots(prev, next)).toEqual([]);
  });

  it('ignores ids that disappeared from next (no removal events)', () => {
    const prev: BoardNotificationSnapshot = {
      readyTicketIds: new Set(['bdboard-a', 'bdboard-b']),
      decisionPendingTicketIds: new Set(['bdboard-x']),
    };
    const next: BoardNotificationSnapshot = {
      readyTicketIds: new Set(['bdboard-a']),
      decisionPendingTicketIds: new Set(),
    };

    expect(diffBoardNotificationSnapshots(prev, next)).toEqual([]);
  });
});

describe('diffSessionLiveness', () => {
  it('detects alive to dead transitions as session_died', () => {
    const prev = [
      makeSession({
        sessionId: 'session-1',
        alive: true,
        cwd: '/projects/a',
        name: 'agent-a',
        lastActivityAt: NOW,
      }),
    ];
    const next = [
      makeSession({
        sessionId: 'session-1',
        alive: false,
        cwd: '/projects/a',
        name: 'agent-a',
        lastActivityAt: NOW,
      }),
    ];

    expect(diffSessionLiveness(prev, next)).toEqual([
      {
        kind: 'session_died',
        sessionId: 'session-1',
        cwd: '/projects/a',
        name: 'agent-a',
        lastActivityAt: NOW,
      },
    ]);
  });

  it('ignores sessions that were already dead', () => {
    const prev = [
      makeSession({ sessionId: 'session-1', alive: false }),
    ];
    const next = [
      makeSession({ sessionId: 'session-1', alive: false }),
    ];

    expect(diffSessionLiveness(prev, next)).toEqual([]);
  });

  it('ignores sessions that stay alive', () => {
    const prev = [
      makeSession({ sessionId: 'session-1', alive: true }),
    ];
    const next = [
      makeSession({ sessionId: 'session-1', alive: true }),
    ];

    expect(diffSessionLiveness(prev, next)).toEqual([]);
  });

  it('ignores new sessions that first appear as dead', () => {
    const prev: ReturnType<typeof makeSession>[] = [];
    const next = [
      makeSession({ sessionId: 'session-new', alive: false }),
    ];

    expect(diffSessionLiveness(prev, next)).toEqual([]);
  });
});
