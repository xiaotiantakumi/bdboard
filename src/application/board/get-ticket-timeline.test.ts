import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { InteractionRecord } from '../../domain/interaction.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptySessionLinksCacheMethods,
  createInMemoryInteractionsCacheMethods,
} from '../ports/board-cache-fakes.js';
import { getTicketTimeline } from './get-ticket-timeline.js';

const TARGET_TICKET_ID = 'bdboard-timeline-target';
const OTHER_TICKET_ID = 'bdboard-timeline-other';

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

describe('getTicketTimeline', () => {
  it('includes created lifecycle event for the target ticket', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: TARGET_TICKET_ID,
          projectId: proj.id,
          createdAt,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const events = getTicketTimeline(cache, TARGET_TICKET_ID);

    expect(events.some((event) => event.kind === 'created' && event.at === createdAt)).toBe(
      true,
    );
  });

  it('enriches started and closed events from status interactions', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    const createdAt = new Date('2026-06-01T08:00:00.000Z');
    const startedAt = new Date('2026-06-01T09:00:00.000Z');
    const closedAt = new Date('2026-06-01T10:00:00.000Z');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: TARGET_TICKET_ID,
          projectId: proj.id,
          createdAt,
          startedAt,
          closedAt,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    cache.appendInteraction(
      interactionRecord({
        id: 'int-started',
        ticketId: TARGET_TICKET_ID,
        at: new Date('2026-06-01T09:05:00.000Z'),
        actor: 'example-starter',
        oldValue: 'open',
        newValue: 'in_progress',
        reason: 'example start reason',
      }),
    );
    cache.appendInteraction(
      interactionRecord({
        id: 'int-closed',
        ticketId: TARGET_TICKET_ID,
        at: new Date('2026-06-01T10:05:00.000Z'),
        actor: 'example-closer',
        oldValue: 'in_progress',
        newValue: 'closed',
        reason: 'example close reason',
      }),
    );

    const events = getTicketTimeline(cache, TARGET_TICKET_ID);
    const started = events.find((event) => event.kind === 'started');
    const closed = events.find((event) => event.kind === 'closed');

    expect(started).toMatchObject({
      kind: 'started',
      actor: 'example-starter',
      from: 'open',
      to: 'in_progress',
      reason: 'example start reason',
    });
    expect(closed).toMatchObject({
      kind: 'closed',
      actor: 'example-closer',
      from: 'in_progress',
      to: 'closed',
      reason: 'example close reason',
    });
    expect(events.filter((event) => event.kind === 'status_changed')).toHaveLength(0);
  });

  it('emits priority_changed events from priority interactions', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    const changedAt = new Date('2026-06-01T09:30:00.000Z');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: TARGET_TICKET_ID,
          projectId: proj.id,
          createdAt: new Date('2026-06-01T08:00:00.000Z'),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    cache.appendInteraction(
      interactionRecord({
        id: 'int-priority',
        ticketId: TARGET_TICKET_ID,
        at: changedAt,
        field: 'priority',
        oldValue: '2',
        newValue: '1',
      }),
    );

    const events = getTicketTimeline(cache, TARGET_TICKET_ID);
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

  it('returns only events for the requested ticket id', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: TARGET_TICKET_ID,
          projectId: proj.id,
          createdAt: new Date('2026-06-01T08:00:00.000Z'),
          startedAt: new Date('2026-06-01T09:00:00.000Z'),
        }),
        makeTicket({
          id: OTHER_TICKET_ID,
          projectId: proj.id,
          createdAt: new Date('2026-06-01T07:00:00.000Z'),
          closedAt: new Date('2026-06-01T11:00:00.000Z'),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    cache.appendInteraction(
      interactionRecord({
        id: 'int-other',
        ticketId: OTHER_TICKET_ID,
        at: new Date('2026-06-01T11:05:00.000Z'),
        actor: 'example-other',
      }),
    );
    cache.appendInteraction(
      interactionRecord({
        id: 'int-target-priority',
        ticketId: TARGET_TICKET_ID,
        at: new Date('2026-06-01T09:30:00.000Z'),
        field: 'priority',
        oldValue: '2',
        newValue: '1',
      }),
    );

    const events = getTicketTimeline(cache, TARGET_TICKET_ID);

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.ticket.id === TARGET_TICKET_ID)).toBe(true);
  });

  it('returns an empty array for a missing ticket id', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: OTHER_TICKET_ID,
          projectId: proj.id,
          createdAt: new Date('2026-06-01T08:00:00.000Z'),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    expect(getTicketTimeline(cache, 'bdboard-missing')).toEqual([]);
  });

  it('limits the number of returned events', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: TARGET_TICKET_ID,
          projectId: proj.id,
          createdAt: new Date('2026-06-01T08:00:00.000Z'),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    for (let index = 0; index < 5; index += 1) {
      cache.appendInteraction(
        interactionRecord({
          id: `int-limit-${index}`,
          ticketId: TARGET_TICKET_ID,
          at: new Date(`2026-06-01T1${index}:00:00.000Z`),
          field: 'title',
          oldValue: `old-${index}`,
          newValue: `new-${index}`,
        }),
      );
    }

    expect(getTicketTimeline(cache, TARGET_TICKET_ID, { limit: 3 })).toHaveLength(3);
    expect(getTicketTimeline(cache, TARGET_TICKET_ID)).toHaveLength(6);
  });
});
