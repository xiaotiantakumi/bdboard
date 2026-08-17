import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import { getHygieneIssues } from './get-hygiene-issues.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

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

describe('getHygieneIssues', () => {
  it('aggregates hygiene issues across projects', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-overdue',
          projectId: a.id,
          status: 'deferred',
          deferUntil: new Date(NOW.getTime() - 1),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-missing',
          projectId: b.id,
          priority: undefined as never,
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const issues = getHygieneIssues(cache, NOW);
    expect(issues.map((issue) => issue.kind).sort()).toEqual([
      'missing_priority',
      'overdue_defer',
    ]);
  });

  it('filters by projectIds and recalculates from remaining tickets', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-overdue',
          projectId: a.id,
          status: 'deferred',
          deferUntil: new Date(NOW.getTime() - 1),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [
        makeTicket({
          id: 'bdboard-missing',
          projectId: b.id,
          priority: undefined as never,
        }),
      ],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const filtered = getHygieneIssues(cache, NOW, { projectIds: [a.id] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.kind).toBe('overdue_defer');
    expect(filtered[0]?.projectId).toBe(a.id);
  });

  it('returns no issues when projectIds is an empty array', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-overdue',
          projectId: a.id,
          status: 'deferred',
          deferUntil: new Date(NOW.getTime() - 1),
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });

    expect(getHygieneIssues(cache, NOW, { projectIds: [] })).toEqual([]);
  });
});
