import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { DependencyEdge } from '../../domain/dependency.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import { getDependencyGraph } from './get-dependency-graph.js';

function edge(
  issueId: string,
  dependsOnId: string,
  kind: DependencyEdge['kind'],
): DependencyEdge {
  return { issueId, dependsOnId, kind };
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

describe('getDependencyGraph', () => {
  it('aggregates tickets from all projects when projectIds is not specified', () => {
    const cache = createFakeBoardCache();
    const now = new Date('2026-08-15T12:00:00.000Z');
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: a.id,
          dependencies: [edge('bdboard-a', 'bdboard-b', 'blocks')],
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, dependencies: [] })],
      fingerprint: 'fp-b',
      fetchedAt: now,
    });

    const graph = getDependencyGraph(cache);

    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes.map((node) => node.ticketId).sort()).toEqual([
      'bdboard-a',
      'bdboard-b',
    ]);
  });

  it('filters projects when projectIds is specified', () => {
    const cache = createFakeBoardCache();
    const now = new Date('2026-08-15T12:00:00.000Z');
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');

    cache.putProject({
      project: a,
      tickets: [
        makeTicket({
          id: 'bdboard-a',
          projectId: a.id,
          dependencies: [edge('bdboard-a', 'bdboard-b', 'blocks')],
        }),
      ],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, dependencies: [] })],
      fingerprint: 'fp-b',
      fetchedAt: now,
    });

    const graph = getDependencyGraph(cache, { projectIds: [a.id] });

    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('returns an empty graph when projectIds is an empty array', () => {
    const cache = createFakeBoardCache();
    const now = new Date('2026-08-15T12:00:00.000Z');
    const a = project('/a', '/projects/a', 'Alpha');

    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id })],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });

    const graph = getDependencyGraph(cache, { projectIds: [] });

    expect(graph).toEqual({ nodes: [], edges: [] });
  });
});
