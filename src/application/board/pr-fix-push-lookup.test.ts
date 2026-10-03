import { describe, expect, it, vi } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { PrStatus } from '../../domain/pr-link.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { Ticket } from '../../domain/ticket.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../ports/board-cache-fakes.js';
import type { CommentReader } from '../ports/comment-reader.js';
import type { PrStatusReader, PrStatusResult } from '../ports/pr-status-reader.js';
import { createPrBadgeShared } from './pr-badge-shared.js';
import { PrBadgeStatusCache } from './pr-badge-status-cache.js';
import { createFixPushLookup, createFixPushWarmer } from './pr-fix-push-lookup.js';

const URL_A = 'https://github.com/example/repo/pull/1';
const URL_B = 'https://github.com/example/repo/pull/2';
const CLOSED_AT = new Date('2026-09-20T10:00:00.000Z');
const UPDATED_AT = new Date('2026-09-21T10:00:00.000Z');

function project(id: string, rootPath: string): Project {
  return { id, name: id, rootPath, prefixes: ['bdboard'], aliasPaths: [] };
}

function createFakeBoardCache(): BoardCache & { readonly entries: Map<string, CachedProject> } {
  const entries = new Map<string, CachedProject>();
  return {
    entries,
    getProject: (projectId) => entries.get(projectId),
    putProject: (entry) => {
      entries.set(entry.project.id, entry);
    },
    listProjects: () =>
      [...entries.values()].sort((a, b) => compareStrings(a.project.rootPath, b.project.rootPath)),
    deleteProject: (projectId) => {
      entries.delete(projectId);
    },
    clear: () => {
      entries.clear();
    },
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

function target(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return makeTicket({
    id,
    projectId: '/a',
    closedAt: CLOSED_AT,
    updatedAt: UPDATED_AT,
    commentCount: 1,
    complexity: 'low',
    models: [{ stage: 'implement', model: 'm1' }],
    ...overrides,
  });
}

function commentReaderFor(urlByTicketId: Record<string, string>): CommentReader {
  return {
    listComments: vi.fn(async (_rootPath: string, issueId: string) => [
      {
        id: 'c1',
        issueId,
        author: 'agent',
        text: `PR: ${urlByTicketId[issueId]}`,
        createdAt: new Date('2026-09-20T09:00:00.000Z'),
      },
    ]),
  };
}

function statusReaderFor(results: Record<string, PrStatusResult>): PrStatusReader {
  return {
    getPrStatus: vi.fn(async (url: string) => results[url] ?? { status: null, reason: 'other' }),
  };
}

const MERGED_WITH_COUNT = (count: number | null): PrStatus => ({
  state: 'merged',
  checkStatus: 'pass',
  fixPushCount: count,
});

describe('createFixPushLookup (bdboard-p5l.27)', () => {
  it('returns a confirmed unknown for a ticket with no comments (no PR link possible)', () => {
    const shared = createPrBadgeShared();
    const lookup = createFixPushLookup(shared);

    expect(lookup(target('t', { commentCount: 0 }))).toEqual({ kind: 'unknown', pending: false });
  });

  it('is pending until the comment scan result is cached, and a confirmed unknown when the scan found no PR', () => {
    const shared = createPrBadgeShared();
    const lookup = createFixPushLookup(shared);
    const ticket = target('t');

    expect(lookup(ticket)).toEqual({ kind: 'unknown', pending: true });

    shared.commentCache.set(ticket.id, ticket.commentCount, ticket.updatedAt.getTime(), null, false);
    expect(lookup(ticket)).toEqual({ kind: 'unknown', pending: false });
  });

  it('is pending when the PR URL is known but its gh status is not cached yet', () => {
    const shared = createPrBadgeShared();
    const ticket = target('t');
    shared.commentCache.set(ticket.id, ticket.commentCount, ticket.updatedAt.getTime(), URL_A, false);

    expect(createFixPushLookup(shared)(ticket)).toEqual({ kind: 'unknown', pending: true });
  });

  it('returns the cached count, including a confirmed 0', () => {
    const shared = createPrBadgeShared(
      new PrBadgeStatusCache({
        initialEntries: [
          { url: URL_A, status: MERGED_WITH_COUNT(0), fetchedAt: 1, mergedPendingRetries: 0 },
          { url: URL_B, status: MERGED_WITH_COUNT(4), fetchedAt: 1, mergedPendingRetries: 0 },
        ],
      }),
    );
    const lookup = createFixPushLookup(shared);
    const zero = target('zero');
    const four = target('four');
    shared.commentCache.set(zero.id, zero.commentCount, zero.updatedAt.getTime(), URL_A, false);
    shared.commentCache.set(four.id, four.commentCount, four.updatedAt.getTime(), URL_B, false);

    expect(lookup(zero)).toEqual({ kind: 'known', count: 0 });
    expect(lookup(four)).toEqual({ kind: 'known', count: 4 });
  });

  it('treats fixPushCount null as a confirmed unknown and an omitted fixPushCount (legacy persisted entry) as pending', () => {
    const shared = createPrBadgeShared(
      new PrBadgeStatusCache({
        initialEntries: [
          { url: URL_A, status: MERGED_WITH_COUNT(null), fetchedAt: 1, mergedPendingRetries: 0 },
          {
            url: URL_B,
            status: { state: 'merged', checkStatus: 'pass' },
            fetchedAt: 1,
            mergedPendingRetries: 0,
          },
        ],
      }),
    );
    const lookup = createFixPushLookup(shared);
    const tried = target('tried');
    const legacy = target('legacy');
    shared.commentCache.set(tried.id, tried.commentCount, tried.updatedAt.getTime(), URL_A, false);
    shared.commentCache.set(legacy.id, legacy.commentCount, legacy.updatedAt.getTime(), URL_B, false);

    expect(lookup(tried)).toEqual({ kind: 'unknown', pending: false });
    expect(lookup(legacy)).toEqual({ kind: 'unknown', pending: true });
  });

  it('reads the last known count past the 60s TTL of a non-terminal (open) status', async () => {
    let nowMs = 1_000;
    const statusCache = new PrBadgeStatusCache({ now: () => nowMs });
    const shared = createPrBadgeShared(statusCache);
    const ticket = target('t');
    shared.commentCache.set(ticket.id, ticket.commentCount, ticket.updatedAt.getTime(), URL_A, false);
    await statusCache.fetchStatus(URL_A, async () => ({
      status: { state: 'open', checkStatus: 'pending', fixPushCount: 2 },
    })).promise;

    nowMs += 10 * 60_000;
    // get() は TTL 切れで undefined (バッジ側の挙動は変えない) だが、統計は最後の値を読む。
    expect(statusCache.get(URL_A)).toBeUndefined();
    expect(createFixPushLookup(shared)(ticket)).toEqual({ kind: 'known', count: 2 });
  });

  it('treats a recorded gh failure as a confirmed unknown so the stats table does not keep polling', async () => {
    const statusCache = new PrBadgeStatusCache();
    const shared = createPrBadgeShared(statusCache);
    const ticket = target('t');
    shared.commentCache.set(ticket.id, ticket.commentCount, ticket.updatedAt.getTime(), URL_A, false);
    await statusCache.fetchStatus(URL_A, async () => ({ status: null, reason: 'other' })).promise;

    expect(createFixPushLookup(shared)(ticket)).toEqual({ kind: 'unknown', pending: false });
  });

  it('ignores a comment-cache entry made for an older version of the ticket (updatedAt changed)', () => {
    const shared = createPrBadgeShared();
    const ticket = target('t');
    shared.commentCache.set(ticket.id, ticket.commentCount, ticket.updatedAt.getTime() - 1, URL_A, false);

    expect(createFixPushLookup(shared)(ticket)).toEqual({ kind: 'unknown', pending: true });
  });
});

describe('createFixPushWarmer (bdboard-p5l.27)', () => {
  function setup(tickets: readonly Ticket[]) {
    const cache = createFakeBoardCache();
    cache.putProject({
      project: project('/a', '/projects/a'),
      tickets,
      fingerprint: 'fp',
      fetchedAt: CLOSED_AT,
    });
    return cache;
  }

  it('fills the shared caches so the lookup turns pending tickets into known counts', async () => {
    const ticket = target('bdboard-t1');
    const cache = setup([ticket]);
    const shared = createPrBadgeShared();
    const commentReader = commentReaderFor({ 'bdboard-t1': URL_A });
    const prStatusReader = statusReaderFor({ [URL_A]: { status: MERGED_WITH_COUNT(3) } });
    const lookup = createFixPushLookup(shared);
    expect(lookup(ticket)).toEqual({ kind: 'unknown', pending: true });

    await createFixPushWarmer({ cache, commentReader, prStatusReader, shared })();

    expect(lookup(ticket)).toEqual({ kind: 'known', count: 3 });
  });

  it('only reads comments and launches gh for closed tickets that have complexity or an implement model', async () => {
    const tickets = [
      target('bdboard-target'),
      target('bdboard-model-only', { complexity: undefined }),
      target('bdboard-complexity-only', { models: undefined }),
      target('bdboard-open', { closedAt: undefined }),
      target('bdboard-unrecorded', { complexity: undefined, models: undefined }),
      target('bdboard-review-model-only', {
        complexity: undefined,
        models: [{ stage: 'review', model: 'm' }],
      }),
    ];
    const cache = setup(tickets);
    const commentReader = commentReaderFor({
      'bdboard-target': URL_A,
      'bdboard-model-only': URL_A,
      'bdboard-complexity-only': URL_A,
      'bdboard-open': URL_B,
      'bdboard-unrecorded': URL_B,
      'bdboard-review-model-only': URL_B,
    });
    const prStatusReader = statusReaderFor({
      [URL_A]: { status: MERGED_WITH_COUNT(1) },
      [URL_B]: { status: MERGED_WITH_COUNT(9) },
    });

    await createFixPushWarmer({
      cache,
      commentReader,
      prStatusReader,
      shared: createPrBadgeShared(),
    })();

    const readTickets = vi.mocked(commentReader.listComments).mock.calls.map((call) => call[1]);
    expect(readTickets.sort()).toEqual([
      'bdboard-complexity-only',
      'bdboard-model-only',
      'bdboard-target',
    ]);
    expect(vi.mocked(prStatusReader.getPrStatus).mock.calls.map((call) => call[0])).toEqual([URL_A]);
  });

  it('re-fetches a legacy persisted entry once (no fixPushCount) but leaves entries that already have a count alone', async () => {
    const legacy = target('bdboard-legacy');
    const fresh = target('bdboard-fresh');
    const cache = setup([legacy, fresh]);
    const statusCache = new PrBadgeStatusCache({
      initialEntries: [
        {
          url: URL_A,
          status: { state: 'merged', checkStatus: 'pass' },
          fetchedAt: 1,
          mergedPendingRetries: 0,
        },
        { url: URL_B, status: MERGED_WITH_COUNT(2), fetchedAt: 1, mergedPendingRetries: 0 },
      ],
    });
    const shared = createPrBadgeShared(statusCache);
    const commentReader = commentReaderFor({ 'bdboard-legacy': URL_A, 'bdboard-fresh': URL_B });
    const prStatusReader = statusReaderFor({ [URL_A]: { status: MERGED_WITH_COUNT(5) } });
    const warm = createFixPushWarmer({ cache, commentReader, prStatusReader, shared });

    await warm();
    await warm();

    // legacy は 1 回だけ取り直し (2 回目の先読みは count が入っているので触らない)、fresh は触らない。
    expect(vi.mocked(prStatusReader.getPrStatus).mock.calls.map((call) => call[0])).toEqual([URL_A]);
    const lookup = createFixPushLookup(shared);
    expect(lookup(legacy)).toEqual({ kind: 'known', count: 5 });
    expect(lookup(fresh)).toEqual({ kind: 'known', count: 2 });
  });

  it('notifies the persistence hook when a legacy permanent entry gains its count', async () => {
    const legacy = target('bdboard-legacy');
    const cache = setup([legacy]);
    const onPersistableChange = vi.fn();
    const statusCache = new PrBadgeStatusCache({
      initialEntries: [
        {
          url: URL_A,
          status: { state: 'merged', checkStatus: 'pass' },
          fetchedAt: 1,
          mergedPendingRetries: 0,
        },
      ],
      onPersistableChange,
    });

    await createFixPushWarmer({
      cache,
      commentReader: commentReaderFor({ 'bdboard-legacy': URL_A }),
      prStatusReader: statusReaderFor({ [URL_A]: { status: MERGED_WITH_COUNT(5) } }),
      shared: createPrBadgeShared(statusCache),
    })();

    expect(onPersistableChange).toHaveBeenCalledTimes(1);
    expect(statusCache.getTerminalEntries()).toEqual([
      expect.objectContaining({ url: URL_A, status: MERGED_WITH_COUNT(5) }),
    ]);
  });

  it('shares one in-flight warm per project filter (single-flight)', async () => {
    const cache = setup([target('bdboard-t1')]);
    const commentReader = commentReaderFor({ 'bdboard-t1': URL_A });
    const prStatusReader = statusReaderFor({ [URL_A]: { status: MERGED_WITH_COUNT(1) } });
    const warm = createFixPushWarmer({
      cache,
      commentReader,
      prStatusReader,
      shared: createPrBadgeShared(),
    });

    await Promise.all([warm(), warm(), warm()]);

    expect(commentReader.listComments).toHaveBeenCalledTimes(1);
    expect(prStatusReader.getPrStatus).toHaveBeenCalledTimes(1);
  });

  it('leaves the ticket as a confirmed unknown, without throwing, when gh fails', async () => {
    const ticket = target('bdboard-t1');
    const cache = setup([ticket]);
    const shared = createPrBadgeShared();
    const logWarn = vi.fn();

    await expect(
      createFixPushWarmer({
        cache,
        commentReader: commentReaderFor({ 'bdboard-t1': URL_A }),
        prStatusReader: statusReaderFor({ [URL_A]: { status: null, reason: 'other' } }),
        shared,
        logWarn,
      })(),
    ).resolves.toBeUndefined();

    expect(createFixPushLookup(shared)(ticket)).toEqual({ kind: 'unknown', pending: false });
  });

  it('swallows an unexpected failure of the whole warm and logs it', async () => {
    const cache = setup([]);
    cache.listProjects = () => {
      throw new Error('cache exploded');
    };
    const logWarn = vi.fn();

    await expect(
      createFixPushWarmer({
        cache,
        commentReader: commentReaderFor({}),
        prStatusReader: statusReaderFor({}),
        shared: createPrBadgeShared(),
        logWarn,
      })(),
    ).resolves.toBeUndefined();

    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('cache exploded'));
  });
});
