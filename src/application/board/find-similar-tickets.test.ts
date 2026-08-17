import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../ports/board-cache-fakes.js';
import { getSimilarTickets } from './find-similar-tickets.js';

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

describe('getSimilarTickets', () => {
  it('returns an empty array when the target ticket is missing', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    cache.putProject({
      project: proj,
      tickets: [makeTicket({ id: 'bdboard-other', projectId: proj.id })],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    expect(getSimilarTickets(cache, 'bdboard-missing')).toEqual([]);
  });

  it('finds similar tickets across projects and excludes the target', () => {
    const cache = createFakeBoardCache();
    const projectA = project('/a', '/projects/a', 'Alpha Project');
    const projectB = project('/b', '/projects/b', 'Beta Project');
    const target = makeTicket({
      id: 'bdboard-target',
      projectId: projectA.id,
      title: 'Similar ticket detection',
      description: 'Show similar tickets in the detail panel',
    });
    const similarInA = makeTicket({
      id: 'bdboard-similar-a',
      projectId: projectA.id,
      title: 'Similar ticket detection',
      description: 'Show similar tickets in the detail panel',
    });
    const similarInB = makeTicket({
      id: 'bdboard-similar-b',
      projectId: projectB.id,
      title: 'Similar ticket panel',
      description: 'Show similar tickets in the detail panel',
    });
    const unrelated = makeTicket({
      id: 'bdboard-unrelated',
      projectId: projectB.id,
      title: 'Mobile tunnel QR code',
      description: 'Fix Safari credential URL handling',
    });

    cache.putProject({
      project: projectA,
      tickets: [target, similarInA],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: projectB,
      tickets: [similarInB, unrelated],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const hits = getSimilarTickets(cache, target.id);

    expect(hits.map((hit) => hit.ticket.id)).toEqual([
      'bdboard-similar-a',
      'bdboard-similar-b',
    ]);
    expect(hits[0]?.project.name).toBe('Alpha Project');
    expect(hits[1]?.project.name).toBe('Beta Project');
    expect(hits.every((hit) => hit.score > 0)).toBe(true);
  });

  it('respects the limit option', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    const target = makeTicket({
      id: 'bdboard-target',
      projectId: proj.id,
      title: 'Similar ticket detection',
      description: 'Detail panel display',
    });
    const similarTickets = Array.from({ length: 6 }, (_, index) =>
      makeTicket({
        id: `bdboard-similar-${index}`,
        projectId: proj.id,
        title: 'Similar ticket detection',
        description: 'Detail panel display',
      }),
    );

    cache.putProject({
      project: proj,
      tickets: [target, ...similarTickets],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    expect(getSimilarTickets(cache, target.id, { limit: 3 })).toHaveLength(3);
  });
});
