import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { InteractionRecord } from '../../domain/interaction.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptySessionLinksCacheMethods, createInMemoryInteractionsCacheMethods } from '../ports/board-cache-fakes.js';
import { getActivityFeed } from './get-activity-feed.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const WINDOW_START = new Date('2026-05-31T12:00:00.000Z');

function project(id: string, rootPath: string, name?: string): Project {
  return {
    id,
    name: name ?? id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function createFakeBoardCache(): BoardCache & {
  readonly entries: Map<string, CachedProject>;
  readonly interactions: ReturnType<typeof createInMemoryInteractionsCacheMethods>['interactions'];
  appendInteraction(record: InteractionRecord): void;
} {
  const entries = new Map<string, CachedProject>();
  const interactionsMethods = createInMemoryInteractionsCacheMethods();

  return {
    entries,
    appendInteraction(record: InteractionRecord): void {
      interactionsMethods.appendInteractions([record]);
    },
    getProject(projectId: string): CachedProject | undefined {
      return entries.get(projectId);
    },
    putProject(entry: CachedProject): void {
      entries.set(entry.project.id, entry);
    },
    listProjects(): readonly CachedProject[] {
      return [...entries.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
    },
    deleteProject(projectId: string): void {
      entries.delete(projectId);
    },
    clear(): void {
      entries.clear();
    },
    getTranscriptOffset(): number | undefined {
      return undefined;
    },
    setTranscriptOffset(): void {},
    addSessionUsage(): void {},
    getSessionUsage(): readonly never[] {
      return [];
    },
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...interactionsMethods,
    close(): void {},
  };
}

function createFakeBoardCacheWithInteractions(): BoardCache & {
  readonly entries: Map<string, CachedProject>;
  readonly interactions: Map<string, InteractionRecord>;
} {
  const entries = new Map<string, CachedProject>();
  const interactionsMethods = createInMemoryInteractionsCacheMethods();

  return {
    entries,
    getProject(projectId: string): CachedProject | undefined {
      return entries.get(projectId);
    },
    putProject(entry: CachedProject): void {
      entries.set(entry.project.id, entry);
    },
    listProjects(): readonly CachedProject[] {
      return [...entries.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
    },
    deleteProject(projectId: string): void {
      entries.delete(projectId);
    },
    clear(): void {
      entries.clear();
      interactionsMethods.interactions.clear();
    },
    getTranscriptOffset(): number | undefined {
      return undefined;
    },
    setTranscriptOffset(): void {},
    addSessionUsage(): void {},
    getSessionUsage(): readonly never[] {
      return [];
    },
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...interactionsMethods,
    close(): void {},
  };
}

function interactionRecord(
  overrides: Partial<InteractionRecord> & Pick<InteractionRecord, 'id' | 'ticketId'>,
): InteractionRecord {
  return {
    at: new Date('2026-06-01T10:00:00.000Z'),
    actor: 'example-agent',
    field: 'status',
    oldValue: 'in_progress',
    newValue: 'closed',
    reason: 'example completion reason',
    ...overrides,
  };
}

describe('getActivityFeed', () => {
  it('includes events at window start and now, excludes just outside the window', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-at-start',
          projectId: proj.id,
          createdAt: WINDOW_START,
        }),
        makeTicket({
          id: 'bdboard-at-now',
          projectId: proj.id,
          createdAt: NOW,
        }),
        makeTicket({
          id: 'bdboard-before-window',
          projectId: proj.id,
          createdAt: new Date(WINDOW_START.getTime() - 1),
        }),
        makeTicket({
          id: 'bdboard-after-now',
          projectId: proj.id,
          createdAt: new Date(NOW.getTime() + 1),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    const events = getActivityFeed(cache, NOW, { windowDays: 1 });
    const ids = events.map((event) => event.ticket.id);

    expect(ids).toEqual(['bdboard-at-now', 'bdboard-at-start']);
  });

  it('emits separate created, started, and closed events for the same ticket', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');
    const startedAt = new Date('2026-06-01T09:00:00.000Z');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-multi',
          projectId: proj.id,
          createdAt,
          startedAt,
          closedAt,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    const events = getActivityFeed(cache, NOW, { windowDays: 1 });

    expect(events).toHaveLength(3);
    expect(events.map((event) => event.kind)).toEqual(['closed', 'started', 'created']);
    expect(events.every((event) => event.ticket.id === 'bdboard-multi')).toBe(true);
  });

  it('skips started and closed when timestamps are absent', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-created-only',
          projectId: proj.id,
          createdAt: new Date('2026-06-01T08:00:00.000Z'),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    const events = getActivityFeed(cache, NOW, { windowDays: 1 });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('created');
  });

  it('orders by at descending, then ticket id ascending for ties', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    const sameAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-z',
          projectId: proj.id,
          createdAt: sameAt,
        }),
        makeTicket({
          id: 'bdboard-a',
          projectId: proj.id,
          createdAt: sameAt,
        }),
        makeTicket({
          id: 'bdboard-m',
          projectId: proj.id,
          createdAt: new Date('2026-06-01T11:00:00.000Z'),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    const events = getActivityFeed(cache, NOW, { windowDays: 1 });

    expect(events.map((event) => event.ticket.id)).toEqual([
      'bdboard-m',
      'bdboard-a',
      'bdboard-z',
    ]);
  });

  it('limits the number of returned events', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    const tickets = Array.from({ length: 5 }, (_, index) =>
      makeTicket({
        id: `bdboard-item-${index}`,
        projectId: proj.id,
        createdAt: new Date(NOW.getTime() - index * 60_000),
      }),
    );

    cache.putProject({
      project: proj,
      tickets,
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    expect(getActivityFeed(cache, NOW, { windowDays: 1, limit: 3 })).toHaveLength(3);
    expect(getActivityFeed(cache, NOW, { windowDays: 1 })).toHaveLength(5);
  });

  it('searches across all projects in the cache', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id, createdAt })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, createdAt })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const events = getActivityFeed(cache, NOW, { windowDays: 1 });

    expect(events.map((event) => event.project.id).sort()).toEqual([a.id, b.id]);
  });

  it('filters events by projectIds when specified', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id, createdAt })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, createdAt })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const events = getActivityFeed(cache, NOW, { windowDays: 1, projectIds: [b.id] });

    expect(events).toHaveLength(1);
    expect(events[0]?.project.id).toBe(b.id);
    expect(events[0]?.ticket.id).toBe('bdboard-b');
  });

  it('returns all projects when projectIds is not specified', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id, createdAt })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, createdAt })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const events = getActivityFeed(cache, NOW, { windowDays: 1 });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.project.id).sort()).toEqual([a.id, b.id]);
  });

  it('returns no events when projectIds is an empty array', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id, createdAt })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    const events = getActivityFeed(cache, NOW, { windowDays: 1, projectIds: [] });

    expect(events).toHaveLength(0);
  });

  it('enriches closed events with actor and reason from interactions without duplicating', () => {
    const cache = createFakeBoardCacheWithInteractions();
    const proj = project('/a', '/projects/a');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-enriched-close',
          projectId: proj.id,
          createdAt: new Date('2026-06-01T08:00:00.000Z'),
          closedAt,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    cache.appendInteractions([
      interactionRecord({
        id: 'int-fake-close',
        ticketId: 'bdboard-enriched-close',
        at: new Date('2026-06-01T10:05:00.000Z'),
        actor: 'example-closer',
        reason: 'example close reason',
        oldValue: 'in_progress',
        newValue: 'closed',
      }),
    ]);

    const events = getActivityFeed(cache, NOW, { windowDays: 1 });
    const closedEvents = events.filter((event) => event.kind === 'closed');

    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0]).toMatchObject({
      kind: 'closed',
      actor: 'example-closer',
      reason: 'example close reason',
      from: 'in_progress',
      to: 'closed',
    });
    expect(events.filter((event) => event.kind === 'status_changed')).toHaveLength(0);
  });

  it('emits priority_changed events from interactions', () => {
    const cache = createFakeBoardCacheWithInteractions();
    const proj = project('/a', '/projects/a');
    const changedAt = new Date('2026-06-01T09:30:00.000Z');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-priority',
          projectId: proj.id,
          createdAt: new Date('2026-06-01T08:00:00.000Z'),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    cache.appendInteractions([
      interactionRecord({
        id: 'int-fake-priority',
        ticketId: 'bdboard-priority',
        at: changedAt,
        field: 'priority',
        oldValue: '2',
        newValue: '1',
      }),
    ]);

    const events = getActivityFeed(cache, NOW, { windowDays: 1 });
    const priorityEvents = events.filter((event) => event.kind === 'priority_changed');

    expect(priorityEvents).toHaveLength(1);
    expect(priorityEvents[0]).toMatchObject({
      kind: 'priority_changed',
      at: changedAt,
      actor: 'example-agent',
      from: '2',
      to: '1',
    });
  });

  it('emits status_changed for status updates that do not enrich existing events', () => {
    const cache = createFakeBoardCacheWithInteractions();
    const proj = project('/a', '/projects/a');
    const reopenedAt = new Date('2026-06-01T11:00:00.000Z');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-reopen',
          projectId: proj.id,
          createdAt: new Date('2026-06-01T08:00:00.000Z'),
          closedAt: new Date('2026-06-01T09:00:00.000Z'),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    cache.appendInteractions([
      interactionRecord({
        id: 'int-fake-reopen',
        ticketId: 'bdboard-reopen',
        at: reopenedAt,
        oldValue: 'closed',
        newValue: 'open',
        reason: 'example reopen reason',
      }),
    ]);

    const events = getActivityFeed(cache, NOW, { windowDays: 1 });
    const statusEvents = events.filter((event) => event.kind === 'status_changed');

    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toMatchObject({
      kind: 'status_changed',
      at: reopenedAt,
      from: 'closed',
      to: 'open',
      reason: 'example reopen reason',
    });
  });

  it('drops interactions for tickets missing from the cache', () => {
    const cache = createFakeBoardCacheWithInteractions();

    cache.appendInteractions([
      interactionRecord({
        id: 'int-fake-orphan',
        ticketId: 'bdboard-missing',
        field: 'priority',
        oldValue: '2',
        newValue: '1',
      }),
    ]);

    const events = getActivityFeed(cache, NOW, { windowDays: 1 });

    expect(events).toHaveLength(0);
  });

  it('uses the interaction closest to the closed event timestamp when enriching', () => {
    const cache = createFakeBoardCacheWithInteractions();
    const proj = project('/a', '/projects/a');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-closest',
          projectId: proj.id,
          createdAt: new Date('2026-06-01T08:00:00.000Z'),
          closedAt,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    cache.appendInteractions([
      interactionRecord({
        id: 'int-fake-far',
        ticketId: 'bdboard-closest',
        at: new Date('2026-06-01T08:00:00.000Z'),
        actor: 'example-far',
        reason: 'far reason',
      }),
      interactionRecord({
        id: 'int-fake-near',
        ticketId: 'bdboard-closest',
        at: new Date('2026-06-01T10:02:00.000Z'),
        actor: 'example-near',
        reason: 'near reason',
      }),
    ]);

    const events = getActivityFeed(cache, NOW, { windowDays: 1 });
    const closedEvent = events.find((event) => event.kind === 'closed');

    expect(closedEvent).toMatchObject({
      actor: 'example-near',
      reason: 'near reason',
    });
    expect(events.filter((event) => event.kind === 'status_changed')).toHaveLength(1);
    expect(events.find((event) => event.kind === 'status_changed')?.actor).toBe('example-far');
  });
});
