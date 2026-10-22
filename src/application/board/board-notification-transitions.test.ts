import { describe, expect, it } from 'vitest';
import type { CachedProject } from '../ports/board-cache.js';
import type { Project } from '../../domain/project.js';
import {
  type BoardNotificationSnapshot,
  type ProjectNotificationSnapshot,
} from '../../domain/board-notifications.js';
import { makeTicket } from '../../domain/test-support.js';
import {
  createBoardNotificationPublisher,
  findTicketMeta,
} from './board-notification-transitions.js';

const OCCURRED_AT = new Date('2026-08-17T12:00:00.000Z');

function project(id: string): Project {
  return {
    id,
    name: id,
    rootPath: `/tmp/${id}`,
    prefixes: [id],
    aliasPaths: [],
  };
}

function cached(entry: Project, tickets: CachedProject['tickets']): CachedProject {
  return {
    project: entry,
    tickets,
    fingerprint: 'fp',
    fetchedAt: new Date('2026-08-15T00:00:00.000Z'),
  };
}

function snapshot(
  overrides: Partial<{
    readyTicketIds: readonly string[];
    decisionPendingTicketIds: readonly string[];
    knownTicketIds: readonly string[];
  }> = {},
  projectId = 'default',
): BoardNotificationSnapshot {
  const projectSnapshot: ProjectNotificationSnapshot = {
    readyTicketIds: new Set(overrides.readyTicketIds ?? []),
    decisionPendingTicketIds: new Set(overrides.decisionPendingTicketIds ?? []),
    knownTicketIds: new Set(overrides.knownTicketIds ?? []),
  };
  return { projects: new Map([[projectId, projectSnapshot]]) };
}

describe('findTicketMeta', () => {
  it('returns title and projectId from the first matching project', () => {
    const entries: CachedProject[] = [
      cached(project('alpha'), [
        makeTicket({ id: 'bdboard-a', title: 'Alpha ticket', projectId: 'alpha' }),
      ]),
      cached(project('beta'), [
        makeTicket({ id: 'bdboard-b', title: 'Beta ticket', projectId: 'beta' }),
      ]),
    ];

    expect(findTicketMeta(entries, 'bdboard-b')).toEqual({
      title: 'Beta ticket',
      projectId: 'beta',
    });
  });

  it('returns the first match when the same ticket id appears in an earlier project', () => {
    const entries: CachedProject[] = [
      cached(project('first'), [
        makeTicket({ id: 'bdboard-dup', title: 'First match', projectId: 'first' }),
      ]),
      cached(project('second'), [
        makeTicket({ id: 'bdboard-dup', title: 'Second match', projectId: 'second' }),
      ]),
    ];

    expect(findTicketMeta(entries, 'bdboard-dup')).toEqual({
      title: 'First match',
      projectId: 'first',
    });
  });

  it('returns undefined when no ticket matches', () => {
    const entries: CachedProject[] = [
      cached(project('alpha'), [
        makeTicket({ id: 'bdboard-a', title: 'Alpha ticket', projectId: 'alpha' }),
      ]),
    ];

    expect(findTicketMeta(entries, 'bdboard-missing')).toBeUndefined();
  });
});

describe('createBoardNotificationPublisher', () => {
  it('does not emit events on the first call when prior state is null', () => {
    const publisher = createBoardNotificationPublisher();
    const next = snapshot({
      readyTicketIds: ['bdboard-a'],
      knownTicketIds: ['bdboard-a'],
    });

    const payloads = publisher.collectTransitions([], next, OCCURRED_AT);

    expect(payloads).toEqual([]);
  });

  it('does not emit events when seeded without a prior collectTransitions call', () => {
    const publisher = createBoardNotificationPublisher();
    const seeded = snapshot({
      readyTicketIds: ['bdboard-a'],
      knownTicketIds: ['bdboard-a', 'bdboard-b'],
    });
    publisher.seedSnapshot(seeded);

    const next = snapshot({
      readyTicketIds: ['bdboard-a', 'bdboard-b'],
      knownTicketIds: ['bdboard-a', 'bdboard-b'],
    });
    const entries: CachedProject[] = [
      cached(project('alpha'), [
        makeTicket({ id: 'bdboard-b', title: 'Ready ticket', projectId: 'alpha' }),
      ]),
    ];

    const payloads = publisher.collectTransitions(entries, next, OCCURRED_AT);

    expect(payloads).toEqual([
      {
        kind: 'ticket_ready',
        ticketId: 'bdboard-b',
        title: 'Ready ticket',
        projectId: 'alpha',
        occurredAt: OCCURRED_AT.toISOString(),
      },
    ]);
  });

  it('omits title and projectId when ticket meta is not found', () => {
    const publisher = createBoardNotificationPublisher();
    publisher.seedSnapshot(
      snapshot({
        readyTicketIds: ['bdboard-a'],
        knownTicketIds: ['bdboard-a', 'bdboard-b'],
      }),
    );

    const next = snapshot({
      readyTicketIds: ['bdboard-a', 'bdboard-b'],
      knownTicketIds: ['bdboard-a', 'bdboard-b'],
    });

    const payloads = publisher.collectTransitions([], next, OCCURRED_AT);

    expect(payloads).toEqual([
      {
        kind: 'ticket_ready',
        ticketId: 'bdboard-b',
        occurredAt: OCCURRED_AT.toISOString(),
      },
    ]);
    expect(payloads[0]).not.toHaveProperty('title');
    expect(payloads[0]).not.toHaveProperty('projectId');
  });

  it('builds ticket_ready payloads with ticket meta', () => {
    const publisher = createBoardNotificationPublisher();
    publisher.seedSnapshot(
      snapshot({
        readyTicketIds: ['bdboard-a'],
        knownTicketIds: ['bdboard-a', 'bdboard-b'],
      }),
    );

    const next = snapshot({
      readyTicketIds: ['bdboard-a', 'bdboard-b'],
      knownTicketIds: ['bdboard-a', 'bdboard-b'],
    });
    const entries: CachedProject[] = [
      cached(project('alpha'), [
        makeTicket({ id: 'bdboard-b', title: 'Ready now', projectId: 'alpha' }),
      ]),
    ];

    const payloads = publisher.collectTransitions(entries, next, OCCURRED_AT);

    expect(payloads).toEqual([
      {
        kind: 'ticket_ready',
        ticketId: 'bdboard-b',
        title: 'Ready now',
        projectId: 'alpha',
        occurredAt: OCCURRED_AT.toISOString(),
      },
    ]);
  });

  it('builds decision_pending payloads with ticket meta', () => {
    const publisher = createBoardNotificationPublisher();
    publisher.seedSnapshot(
      snapshot({
        decisionPendingTicketIds: ['bdboard-a'],
        knownTicketIds: ['bdboard-a', 'bdboard-b'],
      }),
    );

    const next = snapshot({
      decisionPendingTicketIds: ['bdboard-a', 'bdboard-b'],
      knownTicketIds: ['bdboard-a', 'bdboard-b'],
    });
    const entries: CachedProject[] = [
      cached(project('beta'), [
        makeTicket({ id: 'bdboard-b', title: 'Needs human', projectId: 'beta' }),
      ]),
    ];

    const payloads = publisher.collectTransitions(entries, next, OCCURRED_AT);

    expect(payloads).toEqual([
      {
        kind: 'decision_pending',
        ticketId: 'bdboard-b',
        title: 'Needs human',
        projectId: 'beta',
        occurredAt: OCCURRED_AT.toISOString(),
      },
    ]);
  });
});
