import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import { searchTickets } from './search-tickets.js';

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

describe('searchTickets', () => {
  it('returns empty array for empty or whitespace-only query', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    cache.putProject({
      project: proj,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: proj.id })],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    expect(searchTickets(cache, { query: '' })).toEqual([]);
    expect(searchTickets(cache, { query: '   ' })).toEqual([]);
  });

  it('matches id, title, and description case-insensitively', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-UPPER',
          projectId: proj.id,
          title: 'Lower Title',
          description: 'Mixed CASE body',
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    expect(searchTickets(cache, { query: 'upper' }).map((hit) => hit.ticket.id)).toEqual([
      'bdboard-UPPER',
    ]);
    expect(searchTickets(cache, { query: 'LOWER' }).map((hit) => hit.ticket.id)).toEqual([
      'bdboard-UPPER',
    ]);
    expect(searchTickets(cache, { query: 'mixed case' }).map((hit) => hit.ticket.id)).toEqual([
      'bdboard-UPPER',
    ]);
  });

  it('requires all whitespace-separated terms to match somewhere (AND)', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-alpha',
          projectId: proj.id,
          title: 'First word only',
        }),
        makeTicket({
          id: 'bdboard-beta',
          projectId: proj.id,
          title: 'First and second',
          description: 'second appears here',
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    expect(searchTickets(cache, { query: 'first second' }).map((hit) => hit.ticket.id)).toEqual([
      'bdboard-beta',
    ]);
  });

  it('limits results to the requested count (default 30)', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    const tickets = Array.from({ length: 40 }, (_, index) =>
      makeTicket({
        id: `bdboard-item-${index}`,
        projectId: proj.id,
        title: `searchable item ${index}`,
      }),
    );
    cache.putProject({
      project: proj,
      tickets,
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    expect(searchTickets(cache, { query: 'searchable' })).toHaveLength(30);
    expect(searchTickets(cache, { query: 'searchable', limit: 5 })).toHaveLength(5);
  });

  it('orders by match tier: id exact, id prefix, title, description', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    const updated = new Date('2026-06-02T00:00:00.000Z');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-findme',
          projectId: proj.id,
          title: 'Exact id ticket',
          priority: 4,
          updatedAt: updated,
        }),
        makeTicket({
          id: 'bdboard-findme-extra',
          projectId: proj.id,
          title: 'Prefix id ticket',
          priority: 0,
          updatedAt: updated,
        }),
        makeTicket({
          id: 'bdboard-other-1',
          projectId: proj.id,
          title: 'bdboard-findme in title',
          priority: 0,
          updatedAt: updated,
        }),
        makeTicket({
          id: 'bdboard-other-2',
          projectId: proj.id,
          title: 'Unrelated',
          description: 'bdboard-findme in description',
          priority: 0,
          updatedAt: updated,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    // Query is the full id so that the exact-id and prefix-id tiers are actually
    // exercised; a bare 'findme' would match no id exactly nor by prefix.
    const ids = searchTickets(cache, { query: 'bdboard-findme' }).map((hit) => hit.ticket.id);
    expect(ids).toEqual([
      'bdboard-findme',
      'bdboard-findme-extra',
      'bdboard-other-1',
      'bdboard-other-2',
    ]);
  });

  it('breaks ties by priority ascending, then newer updatedAt, then id ascending', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');

    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-z',
          projectId: proj.id,
          title: 'rank tie',
          priority: 2,
          updatedAt: new Date('2026-06-01T12:00:00.000Z'),
        }),
        makeTicket({
          id: 'bdboard-a',
          projectId: proj.id,
          title: 'rank tie',
          priority: 2,
          updatedAt: new Date('2026-06-03T12:00:00.000Z'),
        }),
        makeTicket({
          id: 'bdboard-m',
          projectId: proj.id,
          title: 'rank tie',
          priority: 0,
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    const ids = searchTickets(cache, { query: 'rank tie' }).map((hit) => hit.ticket.id);
    expect(ids).toEqual(['bdboard-m', 'bdboard-a', 'bdboard-z']);
  });

  it('searches across all projects in the cache', () => {
    const cache = createFakeBoardCache();
    const a = project('/a', '/projects/a', 'Alpha');
    const b = project('/b', '/projects/b', 'Beta');
    cache.putProject({
      project: a,
      tickets: [makeTicket({ id: 'bdboard-a', projectId: a.id, title: 'shared term' })],
      fingerprint: 'fp-a',
      fetchedAt: NOW,
    });
    cache.putProject({
      project: b,
      tickets: [makeTicket({ id: 'bdboard-b', projectId: b.id, title: 'shared term' })],
      fingerprint: 'fp-b',
      fetchedAt: NOW,
    });

    const hits = searchTickets(cache, { query: 'shared' });
    expect(hits.map((hit) => hit.project.id).sort()).toEqual([a.id, b.id]);
  });
});
