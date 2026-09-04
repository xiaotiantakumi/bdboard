import { describe, expect, it, vi } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import { pendingDecisionKey } from '../../domain/hygiene.js';
import type { IssueComment } from '../../domain/issue-comment.js';
import type { Project } from '../../domain/project.js';
import { DEFAULT_HYGIENE_THRESHOLDS } from '../../domain/hygiene-thresholds.js';
import { makeTicket } from '../../domain/test-support.js';
import type { TicketId } from '../../domain/ticket-id.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../ports/board-cache-fakes.js';
import type { CommentReader } from '../ports/comment-reader.js';
import {
  CLOSE_EVIDENCE_FETCH_BUDGET_MS,
  CloseEvidenceCache,
  getCloseEvidence,
} from './get-close-evidence.js';

const WINDOW_MS = DEFAULT_HYGIENE_THRESHOLDS.closedWithoutEvidenceWindowMs;

function project(id: string, rootPath: string): Project {
  return { id, name: id, rootPath, prefixes: ['bdboard'], aliasPaths: [] };
}

function createFakeBoardCache(): BoardCache {
  const entries = new Map<string, CachedProject>();
  return {
    getProject: (id: string) => entries.get(id),
    putProject: (entry: CachedProject) => {
      entries.set(entry.project.id, entry);
    },
    listProjects: () =>
      [...entries.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      ),
    deleteProject: (id: string) => {
      entries.delete(id);
    },
    clear: () => entries.clear(),
    getTranscriptOffset: () => undefined,
    setTranscriptOffset: () => {},
    addSessionUsage: () => {},
    getSessionUsage: () => [],
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close: () => {},
  };
}

function comment(issueId: TicketId, text: string): IssueComment {
  return {
    id: `${issueId}-1`,
    issueId,
    author: 'someone',
    text,
    createdAt: new Date(0),
  };
}

function readerReturning(
  byId: Readonly<Record<string, readonly IssueComment[]>>,
): CommentReader & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listComments: vi.fn(async (_root: string, issueId: TicketId) => {
      calls.push(issueId);
      return byId[issueId] ?? [];
    }),
  };
}

function closedTicket(
  id: TicketId,
  projectId: string,
  options: {
    readonly closedAtOffsetMs: number;
    readonly commentCount?: number;
    readonly issueType?: string;
    readonly labels?: readonly string[];
    readonly closeReason?: string;
    readonly updatedAtOffsetMs?: number;
  },
) {
  const now = new Date('2026-06-01T12:00:00.000Z');
  return makeTicket({
    id,
    projectId,
    status: 'closed',
    commentCount: options.commentCount ?? 1,
    closedAt: new Date(now.getTime() - options.closedAtOffsetMs),
    updatedAt: new Date(
      now.getTime() - (options.updatedAtOffsetMs ?? options.closedAtOffsetMs),
    ),
    issueType: options.issueType,
    labels: options.labels,
    closeReason: options.closeReason,
  });
}

function fakeClock(startMs: number, stepMs: number): () => number {
  let current = startMs;
  return () => {
    const value = current;
    current += stepMs;
    return value;
  };
}

describe('getCloseEvidence', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');
  const withinWindow = WINDOW_MS - 60_000;

  it('includes a key when a comment contains PR:', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [closedTicket('bdboard-pr', p.id, { closedAtOffsetMs: withinWindow })],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({
      'bdboard-pr': [comment('bdboard-pr', 'merged via PR: https://github.com/x/y/pull/1')],
    });

    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS);

    expect([...result.evidenceKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-pr')]);
    expect(result.unknownKeys.size).toBe(0);
  });

  it('includes a key when a comment contains 検証:', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [closedTicket('bdboard-verify', p.id, { closedAtOffsetMs: withinWindow })],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({
      'bdboard-verify': [comment('bdboard-verify', '手元で検証: npm run verify 通過')],
    });

    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS);

    expect([...result.evidenceKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-verify')]);
  });

  it('accepts full-width colons in PR and 検証 markers', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-full-pr', p.id, { closedAtOffsetMs: withinWindow }),
        closedTicket('bdboard-full-verify', p.id, {
          closedAtOffsetMs: withinWindow,
          commentCount: 2,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({
      'bdboard-full-pr': [comment('bdboard-full-pr', 'PR：https://github.com/x/y/pull/2')],
      'bdboard-full-verify': [
        comment('bdboard-full-verify', '検証：TZ=UTC npm run verify 通過'),
      ],
    });

    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS);

    expect([...result.evidenceKeys].sort()).toEqual(
      [pendingDecisionKey('/a', 'bdboard-full-pr'), pendingDecisionKey('/a', 'bdboard-full-verify')].sort(),
    );
  });

  it('omits a key when no comment contains PR or 検証 markers', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [closedTicket('bdboard-plain', p.id, { closedAtOffsetMs: withinWindow })],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({
      'bdboard-plain': [comment('bdboard-plain', 'close しました')],
    });

    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS);

    expect(result.evidenceKeys.size).toBe(0);
    expect(result.unknownKeys.size).toBe(0);
  });

  it('does not fetch comments for tickets outside the close window', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-old', p.id, { closedAtOffsetMs: WINDOW_MS + 60_000 }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({});
    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS);

    expect(reader.calls).toEqual([]);
    expect(result.evidenceKeys.size).toBe(0);
  });

  it('does not fetch comments when commentCount is zero', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-no-comments', p.id, {
          closedAtOffsetMs: withinWindow,
          commentCount: 0,
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({});
    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS);

    expect(reader.calls).toEqual([]);
    expect(result.evidenceKeys.size).toBe(0);
  });

  it('does not fetch comments for epic, gate, or gt:slot tickets', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-epic', p.id, {
          closedAtOffsetMs: withinWindow,
          issueType: 'epic',
        }),
        closedTicket('bdboard-gate', p.id, {
          closedAtOffsetMs: withinWindow,
          issueType: 'gate',
        }),
        closedTicket('bdboard-slot', p.id, {
          closedAtOffsetMs: withinWindow,
          labels: ['gt:slot'],
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({});
    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS);

    expect(reader.calls).toEqual([]);
    expect(result.evidenceKeys.size).toBe(0);
  });

  it('does not fetch comments when closeReason already has evidence', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-reason', p.id, {
          closedAtOffsetMs: withinWindow,
          closeReason: 'Merged via #123',
        }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({});
    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS);

    expect(reader.calls).toEqual([]);
    expect(result.evidenceKeys.size).toBe(0);
  });

  it('puts fetch failures in unknownKeys and still collects evidence from other tickets', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-bad', p.id, { closedAtOffsetMs: withinWindow }),
        closedTicket('bdboard-good', p.id, { closedAtOffsetMs: withinWindow }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader: CommentReader = {
      listComments: async (_root, issueId) => {
        if (issueId === 'bdboard-bad') {
          throw new Error('bd exploded');
        }
        return [comment('bdboard-good', 'PR: https://github.com/x/y/pull/3')];
      },
    };

    const logWarn = vi.fn();
    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS, { logWarn });

    expect([...result.evidenceKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-good')]);
    expect([...result.unknownKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-bad')]);
    expect(logWarn).toHaveBeenCalledTimes(1);
    const message = logWarn.mock.calls[0]?.[0] as string;
    expect(message).toContain('[close-evidence]');
    expect(message).toContain('1 of');
    expect(message).toContain('bdboard-bad');
    expect(message).toContain('bd exploded');
  });

  it('does not call listComments on cache hit', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    const ticket = closedTicket('bdboard-cached', p.id, { closedAtOffsetMs: withinWindow });
    cache.putProject({
      project: p,
      tickets: [ticket],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const evidenceCache = new CloseEvidenceCache();
    evidenceCache.set(ticket.id, ticket.commentCount, ticket.updatedAt.getTime(), true);

    const reader = readerReturning({});
    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS, {
      cache: evidenceCache,
    });

    expect(reader.listComments).not.toHaveBeenCalled();
    expect([...result.evidenceKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-cached')]);
  });

  it('refetches when commentCount changes', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    const ticket = closedTicket('bdboard-stale-count', p.id, {
      closedAtOffsetMs: withinWindow,
      commentCount: 2,
    });
    cache.putProject({
      project: p,
      tickets: [ticket],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const evidenceCache = new CloseEvidenceCache();
    evidenceCache.set(ticket.id, 1, ticket.updatedAt.getTime(), false);

    const reader = readerReturning({
      'bdboard-stale-count': [comment('bdboard-stale-count', 'PR: https://github.com/x/y/pull/9')],
    });
    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS, {
      cache: evidenceCache,
    });

    expect(reader.calls).toEqual(['bdboard-stale-count']);
    expect([...result.evidenceKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-stale-count')]);
  });

  it('refetches when updatedAt changes', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    const ticket = closedTicket('bdboard-stale-updated', p.id, { closedAtOffsetMs: withinWindow });
    cache.putProject({
      project: p,
      tickets: [ticket],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const evidenceCache = new CloseEvidenceCache();
    evidenceCache.set(ticket.id, ticket.commentCount, ticket.updatedAt.getTime() - 1, false);

    const reader = readerReturning({
      'bdboard-stale-updated': [
        comment('bdboard-stale-updated', 'PR: https://github.com/x/y/pull/10'),
      ],
    });
    await getCloseEvidence(cache, reader, now, WINDOW_MS, { cache: evidenceCache });

    expect(reader.calls).toEqual(['bdboard-stale-updated']);
  });

  it('with fetchBudgetMs 0 does not call listComments and puts all targets in unknownKeys', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-a', p.id, { closedAtOffsetMs: 60_000 }),
        closedTicket('bdboard-b', p.id, { closedAtOffsetMs: 120_000 }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({});
    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS, {
      fetchBudgetMs: 0,
      monotonicNow: fakeClock(0, 1000),
    });

    expect(reader.calls).toEqual([]);
    expect(result.evidenceKeys.size).toBe(0);
    expect([...result.unknownKeys].sort()).toEqual(
      [pendingDecisionKey('/a', 'bdboard-a'), pendingDecisionKey('/a', 'bdboard-b')].sort(),
    );
  });

  it('fetches within time budget and puts deadline-cut candidates in unknownKeys', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-newest', p.id, { closedAtOffsetMs: 60_000 }),
        closedTicket('bdboard-middle', p.id, { closedAtOffsetMs: 120_000 }),
        closedTicket('bdboard-oldest', p.id, { closedAtOffsetMs: 180_000 }),
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({});
    const result = await getCloseEvidence(cache, reader, now, WINDOW_MS, {
      fetchBudgetMs: 2500,
      monotonicNow: fakeClock(0, 1000),
    });

    expect(reader.calls).toHaveLength(2);
    expect(reader.calls).toContain('bdboard-newest');
    expect(reader.calls).toContain('bdboard-middle');
    expect(reader.calls).not.toContain('bdboard-oldest');
    expect([...result.unknownKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-oldest')]);
  });

  it('does not cache deadline-cut tickets and fetches them on a later request', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    const oldest = closedTicket('bdboard-oldest', p.id, { closedAtOffsetMs: 180_000 });
    cache.putProject({
      project: p,
      tickets: [
        closedTicket('bdboard-newest', p.id, { closedAtOffsetMs: 60_000 }),
        closedTicket('bdboard-middle', p.id, { closedAtOffsetMs: 120_000 }),
        oldest,
      ],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const reader = readerReturning({
      'bdboard-oldest': [comment('bdboard-oldest', 'PR: https://github.com/x/y/pull/99')],
    });
    const evidenceCache = new CloseEvidenceCache();

    const first = await getCloseEvidence(cache, reader, now, WINDOW_MS, {
      cache: evidenceCache,
      fetchBudgetMs: 2500,
      monotonicNow: fakeClock(0, 1000),
    });

    expect([...first.unknownKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-oldest')]);
    expect(first.evidenceKeys.has(pendingDecisionKey('/a', 'bdboard-oldest'))).toBe(false);
    expect(
      evidenceCache.get(oldest.id, oldest.commentCount, oldest.updatedAt.getTime()),
    ).toBeUndefined();
    expect(reader.calls).not.toContain('bdboard-oldest');

    const second = await getCloseEvidence(cache, reader, now, WINDOW_MS, {
      cache: evidenceCache,
      fetchBudgetMs: 10_000,
      monotonicNow: fakeClock(0, 100),
    });

    expect(reader.calls).toContain('bdboard-oldest');
    expect([...second.evidenceKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-oldest')]);
    expect(second.unknownKeys.size).toBe(0);
  });

  it('prunes cache entries for tickets no longer on the board', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [closedTicket('bdboard-gone', p.id, { closedAtOffsetMs: withinWindow })],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const evidenceCache = new CloseEvidenceCache();
    const ticket = cache.listProjects()[0]!.tickets[0]!;
    evidenceCache.set(ticket.id, ticket.commentCount, ticket.updatedAt.getTime(), true);
    evidenceCache.set('bdboard-removed', 1, 0, false);

    cache.putProject({
      project: p,
      tickets: [],
      fingerprint: 'fp2',
      fetchedAt: now,
    });

    const reader = readerReturning({});
    await getCloseEvidence(cache, reader, now, WINDOW_MS, { cache: evidenceCache });

    expect(evidenceCache.get('bdboard-gone', 1, 0)).toBeUndefined();
    expect(evidenceCache.get('bdboard-removed', 1, 0)).toBeUndefined();
  });

  it('uses CLOSE_EVIDENCE_FETCH_BUDGET_MS as the default time budget', () => {
    expect(CLOSE_EVIDENCE_FETCH_BUDGET_MS).toBe(2_500);
  });
});
