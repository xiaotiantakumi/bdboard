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
import type { PrStatusReader } from '../ports/pr-status-reader.js';
import {
  CLOSE_EVIDENCE_NEGATIVE_TTL_MS,
  getCloseEvidence,
} from './get-close-evidence.js';
import { getPrBadges, PrBadgeCommentCache } from './get-pr-badges.js';

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

const noopPrStatusReader: PrStatusReader = {
  getPrStatus: vi.fn(async () => null),
};

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

describe('getCloseEvidence', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');
  const withinWindow = WINDOW_MS - 60_000;

  it('reuses PR-badge comment scan and does not call listComments again (AC1)', async () => {
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
    const sharedCache = new PrBadgeCommentCache();

    await getPrBadges(cache, reader, noopPrStatusReader, { commentCache: sharedCache });
    const callsAfterWarm = reader.calls.length;

    const result = await getCloseEvidence(cache, now, WINDOW_MS, {
      sharedCommentCache: sharedCache,
    });

    expect(reader.calls.length).toBe(callsAfterWarm);
    expect([...result.evidenceKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-pr')]);
    expect(result.unknownKeys.size).toBe(0);
  });

  it('puts tickets not yet in the shared cache in unknownKeys (AC3)', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [closedTicket('bdboard-uncached', p.id, { closedAtOffsetMs: withinWindow })],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const sharedCache = new PrBadgeCommentCache();
    const result = await getCloseEvidence(cache, now, WINDOW_MS, {
      sharedCommentCache: sharedCache,
    });

    expect(result.evidenceKeys.size).toBe(0);
    expect([...result.unknownKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-uncached')]);
  });

  it('treats all targets as unknown when sharedCommentCache is omitted (AC3)', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    cache.putProject({
      project: p,
      tickets: [closedTicket('bdboard-no-cache', p.id, { closedAtOffsetMs: withinWindow })],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const result = await getCloseEvidence(cache, now, WINDOW_MS);

    expect(result.evidenceKeys.size).toBe(0);
    expect([...result.unknownKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-no-cache')]);
  });

  it('omits tickets with confirmed no evidence from both evidenceKeys and unknownKeys (AC3)', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    const ticket = closedTicket('bdboard-plain', p.id, { closedAtOffsetMs: withinWindow });
    cache.putProject({
      project: p,
      tickets: [ticket],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const sharedCache = new PrBadgeCommentCache();
    sharedCache.set(
      ticket.id,
      ticket.commentCount,
      ticket.updatedAt.getTime(),
      null,
      false,
    );

    const result = await getCloseEvidence(cache, now, WINDOW_MS, {
      sharedCommentCache: sharedCache,
    });

    expect(result.evidenceKeys.size).toBe(0);
    expect(result.unknownKeys.size).toBe(0);
  });

  it('does not include filtered-out tickets even when the shared cache has evidence (AC3)', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    const outsideWindow = closedTicket('bdboard-old', p.id, {
      closedAtOffsetMs: WINDOW_MS + 60_000,
    });
    const noComments = closedTicket('bdboard-no-comments', p.id, {
      closedAtOffsetMs: withinWindow,
      commentCount: 0,
    });
    const epic = closedTicket('bdboard-epic', p.id, {
      closedAtOffsetMs: withinWindow,
      issueType: 'epic',
    });
    const gate = closedTicket('bdboard-gate', p.id, {
      closedAtOffsetMs: withinWindow,
      issueType: 'gate',
    });
    const slot = closedTicket('bdboard-slot', p.id, {
      closedAtOffsetMs: withinWindow,
      labels: ['gt:slot'],
    });
    const withReason = closedTicket('bdboard-reason', p.id, {
      closedAtOffsetMs: withinWindow,
      closeReason: 'Merged via #123',
    });
    cache.putProject({
      project: p,
      tickets: [outsideWindow, noComments, epic, gate, slot, withReason],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const sharedCache = new PrBadgeCommentCache();
    for (const ticket of [outsideWindow, noComments, epic, gate, slot, withReason]) {
      sharedCache.set(ticket.id, ticket.commentCount, ticket.updatedAt.getTime(), null, true);
    }

    const result = await getCloseEvidence(cache, now, WINDOW_MS, {
      sharedCommentCache: sharedCache,
    });

    expect(result.evidenceKeys.size).toBe(0);
    expect(result.unknownKeys.size).toBe(0);
  });

  it('treats stale shared-cache entries as unknown', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    const ticket = closedTicket('bdboard-stale', p.id, {
      closedAtOffsetMs: withinWindow,
      commentCount: 2,
    });
    cache.putProject({
      project: p,
      tickets: [ticket],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const sharedCache = new PrBadgeCommentCache();
    sharedCache.set(ticket.id, 1, ticket.updatedAt.getTime(), null, true);

    const result = await getCloseEvidence(cache, now, WINDOW_MS, {
      sharedCommentCache: sharedCache,
    });

    expect(result.evidenceKeys.size).toBe(0);
    expect([...result.unknownKeys]).toEqual([pendingDecisionKey('/a', 'bdboard-stale')]);
  });

  it('expires false cache entries after negative TTL but keeps true entries', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    const falseTicket = closedTicket('bdboard-false', p.id, { closedAtOffsetMs: withinWindow });
    const trueTicket = closedTicket('bdboard-true', p.id, {
      closedAtOffsetMs: withinWindow,
      commentCount: 2,
    });
    cache.putProject({
      project: p,
      tickets: [falseTicket, trueTicket],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    let nowMs = 0;
    const sharedCache = new PrBadgeCommentCache({ now: () => nowMs });
    sharedCache.set(
      falseTicket.id,
      falseTicket.commentCount,
      falseTicket.updatedAt.getTime(),
      null,
      false,
    );
    sharedCache.set(
      trueTicket.id,
      trueTicket.commentCount,
      trueTicket.updatedAt.getTime(),
      null,
      true,
    );

    const noExpiry = await getCloseEvidence(cache, now, WINDOW_MS, {
      sharedCommentCache: sharedCache,
      negativeTtlMs: 1000,
    });
    expect(noExpiry.evidenceKeys.has(pendingDecisionKey('/a', 'bdboard-true'))).toBe(true);
    expect(noExpiry.unknownKeys.has(pendingDecisionKey('/a', 'bdboard-false'))).toBe(false);

    nowMs = 1000;
    const afterExpiry = await getCloseEvidence(cache, now, WINDOW_MS, {
      sharedCommentCache: sharedCache,
      negativeTtlMs: 1000,
    });
    expect(afterExpiry.evidenceKeys.has(pendingDecisionKey('/a', 'bdboard-true'))).toBe(true);
    expect(afterExpiry.unknownKeys.has(pendingDecisionKey('/a', 'bdboard-false'))).toBe(true);
  });

  it('logs when unknownKeys remain and stays silent when all targets are confirmed', async () => {
    const cache = createFakeBoardCache();
    const p = project('/a', '/projects/a');
    const unknown = closedTicket('bdboard-unknown-log', p.id, { closedAtOffsetMs: withinWindow });
    const confirmed = closedTicket('bdboard-confirmed', p.id, {
      closedAtOffsetMs: withinWindow,
      commentCount: 2,
    });
    cache.putProject({
      project: p,
      tickets: [unknown, confirmed],
      fingerprint: 'fp',
      fetchedAt: now,
    });

    const sharedCache = new PrBadgeCommentCache();
    sharedCache.set(
      confirmed.id,
      confirmed.commentCount,
      confirmed.updatedAt.getTime(),
      null,
      false,
    );

    const logWarn = vi.fn();
    await getCloseEvidence(cache, now, WINDOW_MS, {
      sharedCommentCache: sharedCache,
      logWarn,
    });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]?.[0]).toContain('not yet covered by the PR-badge comment scan');

    logWarn.mockClear();
    sharedCache.set(
      unknown.id,
      unknown.commentCount,
      unknown.updatedAt.getTime(),
      null,
      false,
    );
    await getCloseEvidence(cache, now, WINDOW_MS, {
      sharedCommentCache: sharedCache,
      logWarn,
    });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('does not prune shared-cache entries for projects outside projectIds filter', async () => {
    const cache = createFakeBoardCache();
    const projectA = project('/a', '/projects/a');
    const projectB = project('/b', '/projects/b');
    cache.putProject({
      project: projectA,
      tickets: [closedTicket('bdboard-a', projectA.id, { closedAtOffsetMs: withinWindow })],
      fingerprint: 'fp-a',
      fetchedAt: now,
    });
    cache.putProject({
      project: projectB,
      tickets: [closedTicket('bdboard-b', projectB.id, { closedAtOffsetMs: withinWindow })],
      fingerprint: 'fp-b',
      fetchedAt: now,
    });

    const sharedCache = new PrBadgeCommentCache();
    const ticketB = cache.listProjects().find((e) => e.project.id === projectB.id)!.tickets[0]!;
    sharedCache.set(
      ticketB.id,
      ticketB.commentCount,
      ticketB.updatedAt.getTime(),
      null,
      true,
    );

    await getCloseEvidence(cache, now, WINDOW_MS, {
      projectIds: [projectA.id],
      sharedCommentCache: sharedCache,
    });

    expect(
      sharedCache.getCloseEvidence(
        ticketB.id,
        ticketB.commentCount,
        ticketB.updatedAt.getTime(),
        CLOSE_EVIDENCE_NEGATIVE_TTL_MS,
      ),
    ).toBe(true);
  });

  it('exports CLOSE_EVIDENCE_NEGATIVE_TTL_MS as five minutes', () => {
    expect(CLOSE_EVIDENCE_NEGATIVE_TTL_MS).toBe(5 * 60_000);
  });
});
