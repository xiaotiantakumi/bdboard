import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import {
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
  createInMemoryCfdCacheMethods,
} from '../ports/board-cache-fakes.js';
import { formatLocalDate, recordCfdSnapshot } from './record-cfd-snapshot.js';

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

describe('recordCfdSnapshot', () => {
  it('does not record twice on the same local date', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 15, 10);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({ id: 'bdboard-1', projectId: proj.id, status: 'open' }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const first = recordCfdSnapshot(cache, now);
    const second = recordCfdSnapshot(cache, localDate(2026, 8, 15, 18));

    expect(first).toEqual({
      recorded: true,
      snapshotDate: formatLocalDate(now),
    });
    expect(second).toEqual({
      recorded: false,
      snapshotDate: formatLocalDate(now),
    });
    expect(cache.listCfdSnapshots()).toHaveLength(1);
  });

  it('records again when the local date changes', () => {
    const cache = createFakeBoardCache();
    const dayOne = localDate(2026, 8, 15, 10);
    const dayTwo = localDate(2026, 8, 16, 9);
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({ id: 'bdboard-1', projectId: proj.id, status: 'open' }),
      ],
      fingerprint: 'fp',
      fetchedAt: dayOne,
    });

    const first = recordCfdSnapshot(cache, dayOne);
    const second = recordCfdSnapshot(cache, dayTwo);

    expect(first.recorded).toBe(true);
    expect(second).toEqual({
      recorded: true,
      snapshotDate: formatLocalDate(dayTwo),
    });
    expect(cache.getLatestCfdSnapshotDate()).toBe(formatLocalDate(dayTwo));
    expect(cache.listCfdSnapshots()).toHaveLength(2);
  });

  it('counts tickets grouped by status across projects', () => {
    const cache = createFakeBoardCache();
    const now = localDate(2026, 8, 15, 12);
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({ id: 'bdboard-a1', projectId: a.id, status: 'open' }),
        makeTicket({ id: 'bdboard-a2', projectId: a.id, status: 'blocked' }),
        makeTicket({ id: 'bdboard-a3', projectId: a.id, status: 'blocked' }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({ id: 'bdboard-b1', projectId: b.id, status: 'in_progress' }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: now,
    });

    recordCfdSnapshot(cache, now);

    const rows = cache.listCfdSnapshots();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: a.id,
          status: 'open',
          count: 1,
          snapshotDate: formatLocalDate(now),
        }),
        expect.objectContaining({
          projectId: a.id,
          status: 'blocked',
          count: 2,
        }),
        expect.objectContaining({
          projectId: b.id,
          status: 'in_progress',
          count: 1,
        }),
      ]),
    );
  });
});
