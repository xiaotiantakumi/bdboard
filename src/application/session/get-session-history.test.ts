import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeSession, makeSessionLink, makeTicket } from '../../domain/test-support.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../ports/board-cache-fakes.js';
import { getSessionHistory } from './get-session-history.js';

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

describe('getSessionHistory', () => {
  it('excludes sessions with alive true', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    cache.putProject({
      project: proj,
      tickets: [],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const alive = makeSession({
      sessionId: 'session-alive',
      cwd: '/projects/a',
      alive: true,
      lastActivityAt: new Date('2026-06-01T12:00:00.000Z'),
    });
    const dead = makeSession({
      sessionId: 'session-dead',
      cwd: '/projects/a',
      alive: false,
      lastActivityAt: new Date('2026-06-01T11:00:00.000Z'),
    });

    const history = getSessionHistory([alive, dead], [], cache);

    expect(history).toHaveLength(1);
    expect(history[0]?.session.sessionId).toBe('session-dead');
  });

  it('orders by lastActivityAt descending, then sessionId ascending for ties', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    cache.putProject({
      project: proj,
      tickets: [],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const sameAt = new Date('2026-06-01T10:00:00.000Z');
    const sessions = [
      makeSession({
        sessionId: 'session-z',
        cwd: '/projects/a',
        alive: false,
        lastActivityAt: sameAt,
      }),
      makeSession({
        sessionId: 'session-a',
        cwd: '/projects/a',
        alive: false,
        lastActivityAt: sameAt,
      }),
      makeSession({
        sessionId: 'session-m',
        cwd: '/projects/a',
        alive: false,
        lastActivityAt: new Date('2026-06-01T11:00:00.000Z'),
      }),
    ];

    const history = getSessionHistory(sessions, [], cache);

    expect(history.map((entry) => entry.session.sessionId)).toEqual([
      'session-m',
      'session-a',
      'session-z',
    ]);
  });

  it('resolves ticket titles from cache when available', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-known',
          projectId: proj.id,
          title: 'Known ticket',
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const session = makeSession({
      sessionId: 'session-1',
      cwd: '/projects/a',
      alive: false,
    });
    const links = [
      makeSessionLink({
        sessionId: 'session-1',
        ticketId: 'bdboard-known',
      }),
      makeSessionLink({
        sessionId: 'session-1',
        ticketId: 'bdboard-missing',
      }),
    ];

    const history = getSessionHistory([session], links, cache);

    expect(history[0]?.tickets).toEqual([
      { ticketId: 'bdboard-known', title: 'Known ticket' },
      { ticketId: 'bdboard-missing' },
    ]);
  });

  it('deduplicates ticket links and sorts ticket ids ascending', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({ id: 'bdboard-z', projectId: proj.id, title: 'Z' }),
        makeTicket({ id: 'bdboard-a', projectId: proj.id, title: 'A' }),
      ],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const session = makeSession({
      sessionId: 'session-1',
      cwd: '/projects/a',
      alive: false,
    });
    const links = [
      makeSessionLink({ sessionId: 'session-1', ticketId: 'bdboard-z' }),
      makeSessionLink({ sessionId: 'session-1', ticketId: 'bdboard-a' }),
      makeSessionLink({ sessionId: 'session-1', ticketId: 'bdboard-z', source: 'transcript' }),
      makeSessionLink({ sessionId: 'session-other', ticketId: 'bdboard-other' }),
    ];

    const history = getSessionHistory([session], links, cache);

    expect(history[0]?.tickets.map((ticket) => ticket.ticketId)).toEqual([
      'bdboard-a',
      'bdboard-z',
    ]);
  });

  it('limits results and defaults to 50', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    cache.putProject({
      project: proj,
      tickets: [],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const sessions = Array.from({ length: 55 }, (_, index) =>
      makeSession({
        sessionId: `session-${index}`,
        cwd: '/projects/a',
        alive: false,
        lastActivityAt: new Date(
          new Date('2026-06-01T12:00:00.000Z').getTime() - index * 60_000,
        ),
      }),
    );

    expect(getSessionHistory(sessions, [], cache, { limit: 3 })).toHaveLength(3);
    expect(getSessionHistory(sessions, [], cache)).toHaveLength(50);
  });

  it('returns empty array when limit is zero or negative', () => {
    const cache = createFakeBoardCache();
    const session = makeSession({ alive: false });

    expect(getSessionHistory([session], [], cache, { limit: 0 })).toEqual([]);
    expect(getSessionHistory([session], [], cache, { limit: -1 })).toEqual([]);
  });

  it('omits project when cwd does not match any project', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a');
    cache.putProject({
      project: proj,
      tickets: [],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const session = makeSession({
      sessionId: 'session-orphan',
      cwd: '/nowhere',
      alive: false,
    });

    const history = getSessionHistory([session], [], cache);

    expect(history[0]?.project).toBeUndefined();
  });

  it('resolves project from cwd via resolveSessionProject', () => {
    const cache = createFakeBoardCache();
    const proj = project('/a', '/projects/a', 'Alpha');
    cache.putProject({
      project: proj,
      tickets: [],
      fingerprint: 'fp',
      fetchedAt: new Date('2026-06-01T12:00:00.000Z'),
    });

    const session = makeSession({
      sessionId: 'session-1',
      cwd: '/projects/a/subdir',
      alive: false,
    });

    const history = getSessionHistory([session], [], cache);

    expect(history[0]?.project).toEqual(proj);
  });
});
