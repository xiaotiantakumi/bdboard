import { describe, expect, it } from 'vitest';
import {
  computeBoardNotificationSnapshot,
  diffBoardNotificationSnapshots,
  diffSessionLiveness,
  type BoardNotificationSnapshot,
  type ProjectNotificationSnapshot,
} from './board-notifications.js';
import { makeSession, makeTicket } from './test-support.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function blocksEdge(issueId: string, dependsOnId: string) {
  return { issueId, dependsOnId, kind: 'blocks' as const };
}

function projectSnapshot(
  overrides: Partial<{
    readyTicketIds: readonly string[];
    decisionPendingTicketIds: readonly string[];
    knownTicketIds: readonly string[];
  }> = {},
): ProjectNotificationSnapshot {
  return {
    readyTicketIds: new Set(overrides.readyTicketIds ?? []),
    decisionPendingTicketIds: new Set(overrides.decisionPendingTicketIds ?? []),
    knownTicketIds: new Set(overrides.knownTicketIds ?? []),
  };
}

function boardSnapshot(
  projects: Record<string, ProjectNotificationSnapshot>,
): BoardNotificationSnapshot {
  return { projects: new Map(Object.entries(projects)) };
}

describe('computeBoardNotificationSnapshot', () => {
  it('includes open unblocked tickets in readyTicketIds', () => {
    const readyTicket = makeTicket({ id: 'bdboard-ready', status: 'open' });
    const snapshot = computeBoardNotificationSnapshot(
      [{ projectId: 'proj', tickets: [readyTicket] }],
      NOW,
    );

    const project = snapshot.projects.get('proj');
    expect(project).toBeDefined();
    expect([...project!.readyTicketIds]).toEqual(['bdboard-ready']);
  });

  it('excludes blocked tickets from readyTicketIds', () => {
    const blocker = makeTicket({ id: 'bdboard-blocker', status: 'open' });
    const blocked = makeTicket({
      id: 'bdboard-blocked',
      status: 'open',
      dependencies: [blocksEdge('bdboard-blocked', 'bdboard-blocker')],
    });
    const snapshot = computeBoardNotificationSnapshot(
      [{ projectId: 'proj', tickets: [blocker, blocked] }],
      NOW,
    );

    const project = snapshot.projects.get('proj');
    expect([...project!.readyTicketIds]).toEqual(['bdboard-blocker']);
  });

  it('collects decisionPendingTicketIds from project input', () => {
    const snapshot = computeBoardNotificationSnapshot(
      [
        {
          projectId: 'proj',
          tickets: [],
          decisionPendingTicketIds: ['bdboard-a', 'bdboard-b'],
        },
      ],
      NOW,
    );

    const project = snapshot.projects.get('proj');
    expect([...project!.decisionPendingTicketIds]).toEqual([
      'bdboard-a',
      'bdboard-b',
    ]);
  });

  it('collects all ticket ids in knownTicketIds regardless of ready status', () => {
    const blocker = makeTicket({ id: 'bdboard-blocker', status: 'open' });
    const blocked = makeTicket({
      id: 'bdboard-blocked',
      status: 'open',
      dependencies: [blocksEdge('bdboard-blocked', 'bdboard-blocker')],
    });
    const inProgress = makeTicket({
      id: 'bdboard-ip',
      status: 'in_progress',
    });
    const snapshot = computeBoardNotificationSnapshot(
      [{ projectId: 'proj', tickets: [blocker, blocked, inProgress] }],
      NOW,
    );

    const project = snapshot.projects.get('proj');
    expect([...project!.knownTicketIds].sort()).toEqual([
      'bdboard-blocked',
      'bdboard-blocker',
      'bdboard-ip',
    ]);
  });

  it('stores per-project snapshots keyed by projectId', () => {
    const ticketA = makeTicket({ id: 'bdboard-a', status: 'open' });
    const ticketB = makeTicket({ id: 'bdboard-b', status: 'closed' });
    const snapshot = computeBoardNotificationSnapshot(
      [
        { projectId: 'proj-a', tickets: [ticketA] },
        { projectId: 'proj-b', tickets: [ticketB] },
      ],
      NOW,
    );

    expect(snapshot.projects.has('proj-a')).toBe(true);
    expect(snapshot.projects.has('proj-b')).toBe(true);
    expect([...snapshot.projects.get('proj-a')!.knownTicketIds]).toEqual([
      'bdboard-a',
    ]);
    expect([...snapshot.projects.get('proj-b')!.knownTicketIds]).toEqual([
      'bdboard-b',
    ]);
  });
});

describe('diffBoardNotificationSnapshots', () => {
  it('emits ticket_ready only for ids newly present in next.readyTicketIds that were already known', () => {
    const prev = boardSnapshot({
      proj: projectSnapshot({
        readyTicketIds: ['bdboard-a'],
        knownTicketIds: ['bdboard-a', 'bdboard-b'],
      }),
    });
    const next = boardSnapshot({
      proj: projectSnapshot({
        readyTicketIds: ['bdboard-a', 'bdboard-b'],
        knownTicketIds: ['bdboard-a', 'bdboard-b'],
      }),
    });

    expect(diffBoardNotificationSnapshots(prev, next)).toEqual([
      { kind: 'ticket_ready', ticketId: 'bdboard-b' },
    ]);
  });

  it('does not emit ticket_ready for newly appeared ticket ids even when ready', () => {
    const prev = boardSnapshot({
      proj: projectSnapshot({
        readyTicketIds: ['bdboard-a'],
        knownTicketIds: ['bdboard-a'],
      }),
    });
    const next = boardSnapshot({
      proj: projectSnapshot({
        readyTicketIds: ['bdboard-a', 'bdboard-new'],
        knownTicketIds: ['bdboard-a', 'bdboard-new'],
      }),
    });

    expect(diffBoardNotificationSnapshots(prev, next)).toEqual([]);
  });

  it('emits ticket_ready for blocked-to-ready transition on a previously known ticket', () => {
    const prev = boardSnapshot({
      proj: projectSnapshot({
        readyTicketIds: ['bdboard-blocker'],
        knownTicketIds: ['bdboard-blocker', 'bdboard-blocked'],
      }),
    });
    const next = boardSnapshot({
      proj: projectSnapshot({
        readyTicketIds: ['bdboard-blocker', 'bdboard-blocked'],
        knownTicketIds: ['bdboard-blocker', 'bdboard-blocked'],
      }),
    });

    expect(diffBoardNotificationSnapshots(prev, next)).toEqual([
      { kind: 'ticket_ready', ticketId: 'bdboard-blocked' },
    ]);
  });

  it('emits decision_pending only for ids newly present in next.decisionPendingTicketIds that were already known', () => {
    const prev = boardSnapshot({
      proj: projectSnapshot({
        decisionPendingTicketIds: ['bdboard-a'],
        knownTicketIds: ['bdboard-a', 'bdboard-b'],
      }),
    });
    const next = boardSnapshot({
      proj: projectSnapshot({
        decisionPendingTicketIds: ['bdboard-a', 'bdboard-b'],
        knownTicketIds: ['bdboard-a', 'bdboard-b'],
      }),
    });

    expect(diffBoardNotificationSnapshots(prev, next)).toEqual([
      { kind: 'decision_pending', ticketId: 'bdboard-b' },
    ]);
  });

  it('does not emit decision_pending for a newly appeared ticket id even when gated', () => {
    const prev = boardSnapshot({
      proj: projectSnapshot({
        knownTicketIds: ['bdboard-a'],
      }),
    });
    const next = boardSnapshot({
      proj: projectSnapshot({
        decisionPendingTicketIds: ['bdboard-a', 'bdboard-new'],
        knownTicketIds: ['bdboard-a', 'bdboard-new'],
      }),
    });

    expect(diffBoardNotificationSnapshots(prev, next)).toEqual([
      { kind: 'decision_pending', ticketId: 'bdboard-a' },
    ]);
  });

  it('does not re-notify ids present in both snapshots', () => {
    const prev = boardSnapshot({
      proj: projectSnapshot({
        readyTicketIds: ['bdboard-a'],
        decisionPendingTicketIds: ['bdboard-x'],
        knownTicketIds: ['bdboard-a', 'bdboard-x'],
      }),
    });
    const next = boardSnapshot({
      proj: projectSnapshot({
        readyTicketIds: ['bdboard-a'],
        decisionPendingTicketIds: ['bdboard-x'],
        knownTicketIds: ['bdboard-a', 'bdboard-x'],
      }),
    });

    expect(diffBoardNotificationSnapshots(prev, next)).toEqual([]);
  });

  it('ignores ids that disappeared from next (no removal events)', () => {
    const prev = boardSnapshot({
      proj: projectSnapshot({
        readyTicketIds: ['bdboard-a', 'bdboard-b'],
        decisionPendingTicketIds: ['bdboard-x'],
        knownTicketIds: ['bdboard-a', 'bdboard-b', 'bdboard-x'],
      }),
    });
    const next = boardSnapshot({
      proj: projectSnapshot({
        readyTicketIds: ['bdboard-a'],
        knownTicketIds: ['bdboard-a'],
      }),
    });

    expect(diffBoardNotificationSnapshots(prev, next)).toEqual([]);
  });

  it('does not emit events for projects that re-enter after cache eviction while still diffing stable projects', () => {
    const prev = boardSnapshot({
      'project-a': projectSnapshot({
        readyTicketIds: ['bdboard-a1'],
        knownTicketIds: ['bdboard-a1', 'bdboard-a2'],
      }),
    });
    const next = boardSnapshot({
      'project-a': projectSnapshot({
        readyTicketIds: ['bdboard-a1', 'bdboard-a2'],
        knownTicketIds: ['bdboard-a1', 'bdboard-a2'],
      }),
      'project-b': projectSnapshot({
        readyTicketIds: ['bdboard-b1', 'bdboard-b2'],
        knownTicketIds: ['bdboard-b1', 'bdboard-b2'],
      }),
    });

    expect(diffBoardNotificationSnapshots(prev, next)).toEqual([
      { kind: 'ticket_ready', ticketId: 'bdboard-a2' },
    ]);
  });

  it('skips projects absent from prev even when they have ready tickets in next', () => {
    const prev = boardSnapshot({
      'project-a': projectSnapshot({
        readyTicketIds: ['bdboard-a'],
        knownTicketIds: ['bdboard-a'],
      }),
    });
    const next = boardSnapshot({
      'project-a': projectSnapshot({
        readyTicketIds: ['bdboard-a'],
        knownTicketIds: ['bdboard-a'],
      }),
      'project-b': projectSnapshot({
        readyTicketIds: ['bdboard-b1', 'bdboard-b2'],
        knownTicketIds: ['bdboard-b1', 'bdboard-b2'],
      }),
    });

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
