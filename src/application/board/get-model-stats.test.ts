import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import { getModelStats } from './get-model-stats.js';

function localDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, second, ms);
}

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

describe('getModelStats', () => {
  it('defaults weeks to 8', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 15, 12);

    cache.putProject({
      project: project('/a', '/projects/a'),
      tickets: [],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getModelStats(cache, now);
    expect(stats.weeklyCloses).toHaveLength(8);
  });

  it('respects weeks option', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 15, 12);

    cache.putProject({
      project: project('/a', '/projects/a'),
      tickets: [],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getModelStats(cache, now, { weeks: 2 });
    expect(stats.weeklyCloses).toHaveLength(2);
  });

  it('filters by projectIds', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 15, 12);
    const mondayStart = localDate(2026, 8, 10, 0, 0, 0, 0);
    const projA = project('/a', '/projects/a');
    const projB = project('/b', '/projects/b');

    cache.putProject({
      project: projA,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: projA.id,
          closedAt: mondayStart,
          models: [{ stage: 'implement', model: 'composer-2.5' }],
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });
    cache.putProject({
      project: projB,
      tickets: [
        makeTicket({
          id: 'bdboard-b',
          projectId: projB.id,
          closedAt: mondayStart,
          models: [{ stage: 'implement', model: 'gpt-5' }],
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: now,
    });

    const stats = getModelStats(cache, now, {
      weeks: 1,
      projectIds: [projA.id],
    });

    expect(stats.weeklyCloses[0]?.counts).toEqual({ 'composer-2.5': 1 });
    expect(stats.stageModelDistribution).toEqual([
      { stage: 'implement', counts: { 'composer-2.5': 1 } },
    ]);
  });

  it('deduplicates same model within one ticket for weeklyCloses', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 13, 12);
    const mondayStart = localDate(2026, 8, 10, 0, 0, 0, 0);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-dup',
          projectId: proj.id,
          closedAt: mondayStart,
          models: [
            { stage: 'implement', model: 'composer-2.5' },
            { stage: 'review', model: 'composer-2.5' },
          ],
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getModelStats(cache, now, { weeks: 1 });
    expect(stats.weeklyCloses[0]?.counts).toEqual({ 'composer-2.5': 1 });
  });

  it('sorts stageModelDistribution by KNOWN_STAGE_ORDER then alphabetically', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 15, 12);
    const closedAt = localDate(2026, 1, 1, 12);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-1',
          projectId: proj.id,
          closedAt,
          models: [{ stage: 'custom', model: 'model-a' }],
        }),
        makeTicket({
          id: 'bdboard-2',
          projectId: proj.id,
          closedAt,
          models: [{ stage: 'review', model: 'model-b' }],
        }),
        makeTicket({
          id: 'bdboard-3',
          projectId: proj.id,
          closedAt,
          models: [{ stage: 'implement', model: 'model-c' }],
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getModelStats(cache, now, { weeks: 1 });
    expect(stats.stageModelDistribution.map((entry) => entry.stage)).toEqual([
      'implement',
      'review',
      'custom',
    ]);
  });

  it('ignores tickets without models', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 13, 12);
    const mondayStart = localDate(2026, 8, 10, 0, 0, 0, 0);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-no-model',
          projectId: proj.id,
          closedAt: mondayStart,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getModelStats(cache, now, { weeks: 1 });
    expect(stats.weeklyCloses[0]?.counts).toEqual({});
    expect(stats.stageModelDistribution).toEqual([]);
  });

  it('includes all closed tickets in stageModelDistribution regardless of week range', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 15, 12);
    const oldClosed = localDate(2020, 1, 6, 12);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-old',
          projectId: proj.id,
          closedAt: oldClosed,
          models: [{ stage: 'test', model: 'legacy-model' }],
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getModelStats(cache, now, { weeks: 1 });
    expect(stats.weeklyCloses[0]?.counts).toEqual({});
    expect(stats.stageModelDistribution).toEqual([
      { stage: 'test', counts: { 'legacy-model': 1 } },
    ]);
  });

  it('creates empty counts for weeks with no data', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 15, 12);

    cache.putProject({
      project: project('/a', '/projects/a'),
      tickets: [],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const stats = getModelStats(cache, now, { weeks: 3 });
    expect(stats.weeklyCloses).toHaveLength(3);
    for (const entry of stats.weeklyCloses) {
      expect(entry.counts).toEqual({});
    }
  });
});
