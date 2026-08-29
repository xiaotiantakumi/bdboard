import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import {
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
  createInMemoryCfdCacheMethods,
} from '../ports/board-cache-fakes.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { getCfdStats } from './get-cfd-stats.js';

function localDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
): Date {
  return new Date(year, month - 1, day, hour);
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
  const cfd = createInMemoryCfdCacheMethods();

  return {
    entries,
    ...cfd,
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
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close(): void {},
  };
}

describe('getCfdStats', () => {
  it('formats multi-day snapshots per project and totals', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 15, 12);
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

    cache.putCfdSnapshot('2026-08-13', localDate(2026, 8, 13, 9), [
      { projectId: a.id, status: 'open', count: 2 },
      { projectId: b.id, status: 'blocked', count: 1 },
    ]);
    cache.putCfdSnapshot('2026-08-14', localDate(2026, 8, 14, 9), [
      { projectId: a.id, status: 'open', count: 1 },
      { projectId: a.id, status: 'blocked', count: 1 },
    ]);
    cache.putCfdSnapshot('2026-08-15', localDate(2026, 8, 15, 9), [
      { projectId: b.id, status: 'in_progress', count: 3 },
    ]);

    const stats = getCfdStats(cache, now, { days: 30 });

    expect(stats.projects.map((entry) => entry.project.id)).toEqual([a.id, b.id]);
    expect(stats.projects[0]?.days).toEqual([
      { date: '2026-08-13', counts: { open: 2 } },
      { date: '2026-08-14', counts: { open: 1, blocked: 1 } },
    ]);
    expect(stats.projects[1]?.days).toEqual([
      { date: '2026-08-13', counts: { blocked: 1 } },
      { date: '2026-08-15', counts: { in_progress: 3 } },
    ]);
    expect(stats.totals).toEqual([
      { date: '2026-08-13', counts: { open: 2, blocked: 1 } },
      { date: '2026-08-14', counts: { open: 1, blocked: 1 } },
      { date: '2026-08-15', counts: { in_progress: 3 } },
    ]);
  });

  it('filters snapshots to the requested day window', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 15, 12);
    const a = project('/a', '/projects/a');

    cache.putProject({
      project: a,
      tickets: [],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });

    cache.putCfdSnapshot('2026-08-01', localDate(2026, 8, 1, 9), [
      { projectId: a.id, status: 'open', count: 9 },
    ]);
    cache.putCfdSnapshot('2026-08-14', localDate(2026, 8, 14, 9), [
      { projectId: a.id, status: 'open', count: 2 },
    ]);
    cache.putCfdSnapshot('2026-08-15', localDate(2026, 8, 15, 9), [
      { projectId: a.id, status: 'open', count: 1 },
    ]);

    const stats = getCfdStats(cache, now, { days: 2 });

    expect(stats.projects[0]?.days).toEqual([
      { date: '2026-08-14', counts: { open: 2 } },
      { date: '2026-08-15', counts: { open: 1 } },
    ]);
    expect(stats.totals).toEqual([
      { date: '2026-08-14', counts: { open: 2 } },
      { date: '2026-08-15', counts: { open: 1 } },
    ]);
  });

  it('filters by projectIds and recalculates totals', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 15, 12);
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

    cache.putCfdSnapshot('2026-08-15', localDate(2026, 8, 15, 9), [
      { projectId: a.id, status: 'open', count: 1 },
      { projectId: b.id, status: 'open', count: 5 },
    ]);

    const stats = getCfdStats(cache, now, { projectIds: [a.id], days: 7 });

    expect(stats.projects).toHaveLength(1);
    expect(stats.projects[0]?.project.id).toBe(a.id);
    expect(stats.totals).toEqual([
      { date: '2026-08-15', counts: { open: 1 } },
    ]);
  });

  it('excludes deleted-project snapshots from unfiltered totals', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 15, 12);
    const live = project('/live', '/projects/live', 'Live');
    const removed = project('/removed', '/projects/removed', 'Removed');

    cache.putProject({
      project: live,
      tickets: [],
      fingerprint: 'fp-live',
      fetchedAt: now,
    });
    cache.putProject({
      project: removed,
      tickets: [],
      fingerprint: 'fp-removed',
      fetchedAt: now,
    });

    cache.putCfdSnapshot('2026-08-15', localDate(2026, 8, 15, 9), [
      { projectId: live.id, status: 'open', count: 2 },
      { projectId: removed.id, status: 'open', count: 99 },
    ]);

    cache.deleteProject(removed.id);

    const stats = getCfdStats(cache, now, { days: 7 });

    expect(stats.projects.map((entry) => entry.project.id)).toEqual([live.id]);
    expect(stats.projects[0]?.days).toEqual([
      { date: '2026-08-15', counts: { open: 2 } },
    ]);
    expect(stats.totals).toEqual([
      { date: '2026-08-15', counts: { open: 2 } },
    ]);
  });

  it('uses the specified timezone for cutoff calculation', () => {
    const cache = createFakeBoardCache();
    const now = new Date('2026-08-15T20:00:00.000Z');
    const a = project('/a', '/projects/a');

    cache.putProject({
      project: a,
      tickets: [],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });

    cache.putCfdSnapshot('2026-08-14', localDate(2026, 8, 14, 9), [
      { projectId: a.id, status: 'open', count: 2 },
    ]);
    cache.putCfdSnapshot('2026-08-15', localDate(2026, 8, 15, 9), [
      { projectId: a.id, status: 'open', count: 1 },
    ]);
    cache.putCfdSnapshot('2026-08-16', localDate(2026, 8, 16, 9), [
      { projectId: a.id, status: 'open', count: 3 },
    ]);

    const utcStats = getCfdStats(cache, now, { days: 2, timeZone: 'UTC' });
    const utcDates = utcStats.projects[0]?.days.map((entry) => entry.date) ?? [];
    expect(utcDates).toContain('2026-08-14');
    expect(utcDates).toContain('2026-08-16');

    const tokyoStats = getCfdStats(cache, now, { days: 2, timeZone: 'Asia/Tokyo' });
    const tokyoDates = tokyoStats.projects[0]?.days.map((entry) => entry.date) ?? [];
    expect(tokyoDates).not.toContain('2026-08-14');
    expect(tokyoDates).toContain('2026-08-16');
  });
});
