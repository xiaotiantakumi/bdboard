import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import { getThroughputStats } from './get-throughput-stats.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function utcInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
}

const UTC = 'UTC';

function project(id: string, rootPath: string, name?: string): Project {
  return {
    id,
    name: name ?? id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function createFakeBoardCache(): BoardCache & { readonly entries: Map<string, CachedProject> } {
  const entries = new Map<string, CachedProject>();

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
    ...createEmptyInteractionsCacheMethods(),
    close(): void {},
  };
}

describe('getThroughputStats', () => {
  it('defaults weeks to 8', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 15, 12);

    cache.putProject({
      project: project('/a', '/projects/a'),
      tickets: [],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getThroughputStats(cache, now, { timeZone: UTC });
    expect(stats.totals.weeklyCloses).toHaveLength(8);
    expect(stats.projects[0]?.weeklyCloses).toHaveLength(8);
  });

  it('counts closedAt at Monday 00:00:00.000 local in that week', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 13, 12);
    const mondayStart = utcInstant(2026, 8, 10, 0, 0, 0, 0);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-monday',
          projectId: proj.id,
          closedAt: mondayStart,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getThroughputStats(cache, now, { weeks: 1, timeZone: UTC });
    expect(stats.totals.weeklyCloses).toEqual([{ weekStart: mondayStart, count: 1 }]);
  });

  it('counts closedAt at Sunday 23:59:59.999 local in the same week', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 13, 12);
    const mondayStart = utcInstant(2026, 8, 10, 0, 0, 0, 0);
    const sundayEnd = utcInstant(2026, 8, 16, 23, 59, 59, 999);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-sunday',
          projectId: proj.id,
          closedAt: sundayEnd,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getThroughputStats(cache, now, { weeks: 1, timeZone: UTC });
    expect(stats.totals.weeklyCloses).toEqual([{ weekStart: mondayStart, count: 1 }]);
  });

  it('fills zero-count weeks and returns weeks in ascending order', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 15, 12);
    const currentWeekStart = utcInstant(2026, 8, 10, 0, 0, 0, 0);
    const previousWeekStart = utcInstant(2026, 8, 3, 0, 0, 0, 0);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-current-week',
          projectId: proj.id,
          closedAt: utcInstant(2026, 8, 12, 10),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getThroughputStats(cache, now, { weeks: 2, timeZone: UTC });
    expect(stats.totals.weeklyCloses).toHaveLength(2);
    expect(stats.totals.weeklyCloses[0]).toEqual({
      weekStart: previousWeekStart,
      count: 0,
    });
    expect(stats.totals.weeklyCloses[1]).toEqual({
      weekStart: currentWeekStart,
      count: 1,
    });
  });

  it('ignores closedAt outside the requested week range', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 15, 12);
    const currentWeekStart = utcInstant(2026, 8, 10, 0, 0, 0, 0);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-too-old',
          projectId: proj.id,
          closedAt: new Date(currentWeekStart.getTime() - 1),
        }),
        makeTicket({
          id: 'bdboard-too-new',
          projectId: proj.id,
          closedAt: new Date(currentWeekStart.getTime() + 7 * MS_PER_DAY),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getThroughputStats(cache, now, { weeks: 1, timeZone: UTC });
    expect(stats.totals.weeklyCloses).toEqual([{ weekStart: currentWeekStart, count: 0 }]);
  });

  it('does not count tickets without closedAt in weekly closes', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 15, 12);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-open',
          projectId: proj.id,
          createdAt: utcInstant(2026, 8, 1),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getThroughputStats(cache, now, { weeks: 1, timeZone: UTC });
    expect(stats.totals.weeklyCloses[0]?.count).toBe(0);
  });

  it('places open tickets in age buckets using lower-inclusive upper-exclusive boundaries', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 15, 12);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-age-half-day',
          projectId: proj.id,
          createdAt: new Date(now.getTime() - 0.5 * MS_PER_DAY),
        }),
        makeTicket({
          id: 'bdboard-age-exactly-1',
          projectId: proj.id,
          createdAt: new Date(now.getTime() - 1 * MS_PER_DAY),
        }),
        makeTicket({
          id: 'bdboard-age-exactly-7',
          projectId: proj.id,
          createdAt: new Date(now.getTime() - 7 * MS_PER_DAY),
        }),
        makeTicket({
          id: 'bdboard-age-exactly-30',
          projectId: proj.id,
          createdAt: new Date(now.getTime() - 30 * MS_PER_DAY),
        }),
        makeTicket({
          id: 'bdboard-age-future',
          projectId: proj.id,
          createdAt: new Date(now.getTime() + MS_PER_DAY),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getThroughputStats(cache, now, { weeks: 1, timeZone: UTC });
    expect(stats.totals.openTicketAge).toEqual({
      d0to1: 2,
      d1to7: 1,
      d7to30: 1,
      d30plus: 1,
    });
  });

  it('does not include closed tickets in open ticket age distribution', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 15, 12);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-closed-old',
          projectId: proj.id,
          createdAt: new Date(now.getTime() - 60 * MS_PER_DAY),
          closedAt: utcInstant(2026, 8, 14),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getThroughputStats(cache, now, { weeks: 1, timeZone: UTC });
    expect(stats.totals.openTicketAge).toEqual({
      d0to1: 0,
      d1to7: 0,
      d7to30: 0,
      d30plus: 0,
    });
  });

  it('aggregates totals across projects and preserves listProjects order', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 15, 12);
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');

    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-b-open',
          projectId: b.id,
          createdAt: new Date(now.getTime() - 2 * MS_PER_DAY),
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: now,
    });
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a-closed',
          projectId: a.id,
          closedAt: utcInstant(2026, 8, 12),
        }),
        makeTicket({
          id: 'bdboard-a-open',
          projectId: a.id,
          createdAt: new Date(now.getTime() - 0.5 * MS_PER_DAY),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });

    const stats = getThroughputStats(cache, now, { weeks: 1, timeZone: UTC });

    expect(stats.projects.map((entry) => entry.project.id)).toEqual([a.id, b.id]);
    expect(stats.projects[0]?.weeklyCloses[0]?.count).toBe(1);
    expect(stats.projects[1]?.weeklyCloses[0]?.count).toBe(0);
    expect(stats.totals.weeklyCloses[0]?.count).toBe(1);
    expect(stats.totals.openTicketAge.d0to1).toBe(1);
    expect(stats.totals.openTicketAge.d1to7).toBe(1);
  });

  it('is deterministic for a fixed now', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 15, 12);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-1',
          projectId: proj.id,
          createdAt: new Date(now.getTime() - 3 * MS_PER_DAY),
        }),
        makeTicket({
          id: 'bdboard-2',
          projectId: proj.id,
          closedAt: utcInstant(2026, 8, 12),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const first = getThroughputStats(cache, now, { weeks: 3, timeZone: UTC });
    const second = getThroughputStats(cache, now, { weeks: 3, timeZone: UTC });
    expect(second).toEqual(first);
  });

  it('filters projects and recalculates totals when projectIds is specified', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 15, 12);
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');

    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-b-open',
          projectId: b.id,
          createdAt: new Date(now.getTime() - 2 * MS_PER_DAY),
        }),
        makeTicket({
          id: 'bdboard-b-closed',
          projectId: b.id,
          closedAt: utcInstant(2026, 8, 12),
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: now,
    });
    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a-closed',
          projectId: a.id,
          closedAt: utcInstant(2026, 8, 12),
        }),
        makeTicket({
          id: 'bdboard-a-open',
          projectId: a.id,
          createdAt: new Date(now.getTime() - 0.5 * MS_PER_DAY),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });

    const allStats = getThroughputStats(cache, now, { weeks: 1, timeZone: UTC });
    const filteredStats = getThroughputStats(cache, now, {
      weeks: 1,
      projectIds: [a.id],
      timeZone: UTC,
    });

    expect(allStats.projects).toHaveLength(2);
    expect(allStats.totals.weeklyCloses[0]?.count).toBe(2);
    expect(allStats.totals.openTicketAge.d0to1).toBe(1);
    expect(allStats.totals.openTicketAge.d1to7).toBe(1);

    expect(filteredStats.projects).toHaveLength(1);
    expect(filteredStats.projects[0]?.project.id).toBe(a.id);
    expect(filteredStats.totals.weeklyCloses[0]?.count).toBe(1);
    expect(filteredStats.totals.openTicketAge.d0to1).toBe(1);
    expect(filteredStats.totals.openTicketAge.d1to7).toBe(0);
  });

  it('returns all projects when projectIds is not specified', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 15, 12);
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');

    cache.putProject({
      project: a,
      tickets: [],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });
    cache.putProject({
      project: b,
      tickets: [],
      fingerprint: 'fp-b',
      fetchedAt: now,
    });

    const stats = getThroughputStats(cache, now, { weeks: 1, timeZone: UTC });

    expect(stats.projects).toHaveLength(2);
  });

  it('returns no projects and zero totals when projectIds is an empty array', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 15, 12);
    const a = project('/a', '/projects/a', 'Alpha');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a-closed',
          projectId: a.id,
          closedAt: utcInstant(2026, 8, 12),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });

    const stats = getThroughputStats(cache, now, { weeks: 1, projectIds: [], timeZone: UTC });

    expect(stats.projects).toHaveLength(0);
    expect(stats.totals.weeklyCloses[0]?.count).toBe(0);
    expect(stats.totals.openTicketAge).toEqual({
      d0to1: 0,
      d1to7: 0,
      d7to30: 0,
      d30plus: 0,
    });
  });

  it('uses an explicit timezone for weekly boundaries', () => {
    const cache = createFakeBoardCache();
    const now = utcInstant(2026, 8, 15, 3);
    const mondayStart = new Date('2026-08-09T15:00:00.000Z');
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-tz',
          projectId: proj.id,
          closedAt: mondayStart,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getThroughputStats(cache, now, { weeks: 1, timeZone: 'Asia/Tokyo' });
    expect(stats.totals.weeklyCloses[0]?.count).toBe(1);
  });
});
