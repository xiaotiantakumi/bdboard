import { describe, expect, it } from 'vitest';
import type { SessionLink } from '../../domain/session.js';
import type { CachedProject, SessionLinkRow } from '../ports/board-cache.js';
import { createTranscriptLinkTracker } from './transcript-link-tracker.js';

function project(id: string, prefix: string): CachedProject {
  return {
    project: {
      id,
      name: id,
      rootPath: `/repo/${id}`,
      prefixes: [prefix],
    } as unknown as CachedProject['project'],
    tickets: [],
    fingerprint: 'fp',
    fetchedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function link(overrides: Partial<SessionLink> = {}): SessionLink {
  return {
    ticketId: 'bdboard-1',
    sessionId: 'session-1',
    source: 'transcript',
    confidence: 1,
    observedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function createFakeCache(projects: readonly CachedProject[]) {
  const upserted: SessionLinkRow[] = [];
  const rows: SessionLinkRow[] = [];
  return {
    listProjects: () => projects,
    upsertSessionLinks: (newRows: readonly SessionLinkRow[]) => {
      upserted.push(...newRows);
      rows.push(...newRows);
    },
    listSessionLinks: () => rows,
    upserted,
  };
}

describe('createTranscriptLinkTracker (bdboard-sso1.9 move only)', () => {
  it('merge() reports whether any link is new, persists rows with a resolved projectId, and dedupes by (ticketId, sessionId)', () => {
    const cache = createFakeCache([project('bdboard', 'bdboard')]);
    const tracker = createTranscriptLinkTracker({ cache });

    expect(tracker.merge([link()])).toBe(true);
    expect(cache.upserted).toEqual([{ projectId: 'bdboard', link: link() }]);
    expect(tracker.list()).toEqual([link()]);

    // Re-merging the same (ticketId, sessionId) is not "new".
    expect(tracker.merge([link({ confidence: 0.5 })])).toBe(false);
    expect(tracker.list()).toHaveLength(1);
    expect(tracker.list()[0]?.confidence).toBe(0.5);
  });

  it('merge() skips persisting links whose ticket prefix does not resolve to a known project', () => {
    const cache = createFakeCache([]);
    const tracker = createTranscriptLinkTracker({ cache });

    tracker.merge([link({ ticketId: 'unknown-9' })]);

    expect(cache.upserted).toEqual([]);
    // Still tracked in-memory even though it wasn't persisted.
    expect(tracker.list()).toHaveLength(1);
  });

  it('caps to maxLinks, evicting the oldest observedAt first', () => {
    const cache = createFakeCache([project('bdboard', 'bdboard')]);
    const tracker = createTranscriptLinkTracker({ cache, maxLinks: 2 });

    tracker.merge([
      link({ sessionId: 's1', observedAt: new Date('2026-01-01T00:00:00Z') }),
      link({ sessionId: 's2', observedAt: new Date('2026-01-02T00:00:00Z') }),
      link({ sessionId: 's3', observedAt: new Date('2026-01-03T00:00:00Z') }),
    ]);

    const remaining = tracker.list().map((entry) => entry.sessionId);
    expect(remaining).toEqual(['s2', 's3']);
    expect(tracker.size()).toBe(2);
  });

  it('hydrateFromCache() rebuilds in-memory state from cache.listSessionLinks() without re-persisting', () => {
    const cache = createFakeCache([project('bdboard', 'bdboard')]);
    cache.listSessionLinks = () => [{ projectId: 'bdboard', link: link({ sessionId: 'restored' }) }];
    const tracker = createTranscriptLinkTracker({ cache });

    tracker.hydrateFromCache();

    expect(tracker.list().map((entry) => entry.sessionId)).toEqual(['restored']);
    expect(cache.upserted).toEqual([]);
  });

  it('list() sorts by ticketId then sessionId', () => {
    const cache = createFakeCache([project('bdboard', 'bdboard')]);
    const tracker = createTranscriptLinkTracker({ cache });

    tracker.merge([
      link({ ticketId: 'bdboard-2', sessionId: 'b' }),
      link({ ticketId: 'bdboard-1', sessionId: 'z' }),
      link({ ticketId: 'bdboard-1', sessionId: 'a' }),
    ]);

    expect(tracker.list().map((entry) => `${entry.ticketId}:${entry.sessionId}`)).toEqual([
      'bdboard-1:a',
      'bdboard-1:z',
      'bdboard-2:b',
    ]);
  });
});
