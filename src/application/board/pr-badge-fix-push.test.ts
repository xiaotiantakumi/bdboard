import { describe, expect, it, vi } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { PrStatus } from '../../domain/pr-link.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import { Semaphore } from '../concurrency.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../ports/board-cache-fakes.js';
import type { CommentReader } from '../ports/comment-reader.js';
import type { PrStatusReader } from '../ports/pr-status-reader.js';
import { getPrBadges } from './get-pr-badges.js';
import {
  isValidPersistedPrBadgeStatusEntry,
  type PersistedPrBadgeStatusEntry,
} from './pr-badge-status-cache-types.js';
import { PrBadgeStatusCache } from './pr-badge-status-cache.js';
import { resolvePrStatus } from './resolve-pr-status.js';

// bdboard-p5l.27: PrStatus.fixPushCount を既存の PR ステータス経路 (永続エントリの検証・
// キャッシュ・resolvePrStatus・getPrBadges) がどう扱うか。バッジ表示の経路 (requireFixPushCount
// なし) が古い恒久エントリをそのまま使い続けることの回帰ガードを含む。

const URL_A = 'https://github.com/example/repo/pull/1';
const URL_B = 'https://github.com/example/repo/pull/2';

const LEGACY_MERGED: PrStatus = { state: 'merged', checkStatus: 'pass' };
const MERGED_WITH_COUNT: PrStatus = { state: 'merged', checkStatus: 'pass', fixPushCount: 3 };

function persisted(
  url: string,
  status: PrStatus,
): PersistedPrBadgeStatusEntry {
  return { url, status, fetchedAt: 1, mergedPendingRetries: 0 };
}

describe('isValidPersistedPrBadgeStatusEntry: fixPushCount', () => {
  it('accepts a missing count (legacy), null, 0 and a positive integer', () => {
    expect(isValidPersistedPrBadgeStatusEntry(persisted(URL_A, LEGACY_MERGED))).toBe(true);
    expect(
      isValidPersistedPrBadgeStatusEntry(persisted(URL_A, { ...LEGACY_MERGED, fixPushCount: null })),
    ).toBe(true);
    expect(
      isValidPersistedPrBadgeStatusEntry(persisted(URL_A, { ...LEGACY_MERGED, fixPushCount: 0 })),
    ).toBe(true);
    expect(
      isValidPersistedPrBadgeStatusEntry(persisted(URL_A, { ...LEGACY_MERGED, fixPushCount: 7 })),
    ).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN, '3', true, {}])('rejects a corrupt count %j', (fixPushCount) => {
    const entry = {
      ...persisted(URL_A, LEGACY_MERGED),
      status: { ...LEGACY_MERGED, fixPushCount },
    };

    expect(isValidPersistedPrBadgeStatusEntry(entry)).toBe(false);
  });
});

describe('PrBadgeStatusCache.peekStatus', () => {
  it('returns undefined for an unknown URL, the status once fetched, and null for a recorded failure', async () => {
    const cache = new PrBadgeStatusCache();
    expect(cache.peekStatus(URL_A)).toBeUndefined();

    await cache.fetchStatus(URL_A, async () => ({ status: MERGED_WITH_COUNT })).promise;
    await cache.fetchStatus(URL_B, async () => ({ status: null, reason: 'other' })).promise;

    expect(cache.peekStatus(URL_A)).toEqual(MERGED_WITH_COUNT);
    expect(cache.peekStatus(URL_B)).toBeNull();
  });
});

describe('resolvePrStatus: requireFixPushCount', () => {
  function deps(statusCache: PrBadgeStatusCache, reader: PrStatusReader, require?: boolean) {
    return {
      prStatusReader: reader,
      statusCache,
      statusGate: new Semaphore(2),
      budget: { remaining: 10 },
      onDeferred: () => {},
      onAttempt: () => {},
      onFailure: () => {},
      ...(require !== undefined ? { requireFixPushCount: require } : {}),
    };
  }

  it('serves a legacy cached entry as-is by default (badge path never re-fetches)', async () => {
    const statusCache = new PrBadgeStatusCache({ initialEntries: [persisted(URL_A, LEGACY_MERGED)] });
    const reader: PrStatusReader = { getPrStatus: vi.fn(async () => ({ status: MERGED_WITH_COUNT })) };

    await expect(resolvePrStatus(URL_A, deps(statusCache, reader))).resolves.toEqual(LEGACY_MERGED);
    expect(reader.getPrStatus).not.toHaveBeenCalled();
  });

  it('re-fetches a legacy cached entry when the count is required, then stops (the count is cached)', async () => {
    const statusCache = new PrBadgeStatusCache({ initialEntries: [persisted(URL_A, LEGACY_MERGED)] });
    const reader: PrStatusReader = { getPrStatus: vi.fn(async () => ({ status: MERGED_WITH_COUNT })) };

    await expect(resolvePrStatus(URL_A, deps(statusCache, reader, true))).resolves.toEqual(
      MERGED_WITH_COUNT,
    );
    await resolvePrStatus(URL_A, deps(statusCache, reader, true));

    expect(reader.getPrStatus).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch an entry whose count is null (tried, unknown) even when the count is required', async () => {
    const unknownCount: PrStatus = { ...LEGACY_MERGED, fixPushCount: null };
    const statusCache = new PrBadgeStatusCache({ initialEntries: [persisted(URL_A, unknownCount)] });
    const reader: PrStatusReader = { getPrStatus: vi.fn(async () => ({ status: MERGED_WITH_COUNT })) };

    await expect(resolvePrStatus(URL_A, deps(statusCache, reader, true))).resolves.toEqual(unknownCount);
    expect(reader.getPrStatus).not.toHaveBeenCalled();
  });

  it('respects the negative cache (a recent failure) even when the count is required', async () => {
    const statusCache = new PrBadgeStatusCache();
    await statusCache.fetchStatus(URL_A, async () => ({ status: null, reason: 'other' })).promise;
    const reader: PrStatusReader = { getPrStatus: vi.fn(async () => ({ status: MERGED_WITH_COUNT })) };

    await expect(resolvePrStatus(URL_A, deps(statusCache, reader, true))).resolves.toBeNull();
    expect(reader.getPrStatus).not.toHaveBeenCalled();
  });
});

describe('getPrBadges: ticketFilter / requireFixPushCount', () => {
  const proj: Project = { id: '/a', name: 'a', rootPath: '/projects/a', prefixes: ['bdboard'], aliasPaths: [] };

  function cacheWith(tickets: ReturnType<typeof makeTicket>[]): BoardCache {
    const entries = new Map<string, CachedProject>([
      [proj.id, { project: proj, tickets, fingerprint: 'fp', fetchedAt: new Date() }],
    ]);
    return {
      getProject: (projectId) => entries.get(projectId),
      putProject: () => {},
      listProjects: () =>
        [...entries.values()].sort((a, b) => compareStrings(a.project.rootPath, b.project.rootPath)),
      deleteProject: () => {},
      clear: () => {},
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

  const commentReader: CommentReader = {
    listComments: vi.fn(async (_root: string, issueId: string) => [
      {
        id: 'c',
        issueId,
        author: 'agent',
        text: `PR: ${issueId === 'bdboard-a' ? URL_A : URL_B}`,
        createdAt: new Date('2026-09-20T09:00:00.000Z'),
      },
    ]),
  };

  it('only resolves the tickets that pass the filter', async () => {
    vi.mocked(commentReader.listComments).mockClear();
    const reader: PrStatusReader = { getPrStatus: vi.fn(async () => ({ status: MERGED_WITH_COUNT })) };

    const badges = await getPrBadges(
      cacheWith([
        makeTicket({ id: 'bdboard-a', projectId: proj.id, commentCount: 1 }),
        makeTicket({ id: 'bdboard-b', projectId: proj.id, commentCount: 1 }),
      ]),
      commentReader,
      reader,
      { ticketFilter: (ticket) => ticket.id === 'bdboard-a' },
    );

    expect(badges.map((badge) => badge.ticketId)).toEqual(['bdboard-a']);
    expect(commentReader.listComments).toHaveBeenCalledTimes(1);
    expect(reader.getPrStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps using a legacy permanent entry for badges unless requireFixPushCount is set', async () => {
    const tickets = [makeTicket({ id: 'bdboard-a', projectId: proj.id, commentCount: 1 })];
    const reader: PrStatusReader = { getPrStatus: vi.fn(async () => ({ status: MERGED_WITH_COUNT })) };
    const statusCache = new PrBadgeStatusCache({ initialEntries: [persisted(URL_A, LEGACY_MERGED)] });

    const plain = await getPrBadges(cacheWith(tickets), commentReader, reader, { statusCache });
    expect(plain[0]?.status).toEqual(LEGACY_MERGED);
    expect(reader.getPrStatus).not.toHaveBeenCalled();

    const required = await getPrBadges(cacheWith(tickets), commentReader, reader, {
      statusCache,
      requireFixPushCount: true,
    });
    expect(required[0]?.status).toEqual(MERGED_WITH_COUNT);
    expect(reader.getPrStatus).toHaveBeenCalledTimes(1);
  });
});
