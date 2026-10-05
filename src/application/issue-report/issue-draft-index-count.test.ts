import { describe, expect, it, vi } from 'vitest';
import type { DraftStatus, IssueDraft } from '../../domain/issue-draft.js';
import type { DraftListing } from '../ports/issue-draft-storage.js';
import {
  INCOMPLETE_INDEX_COUNT_REUSE_MS,
  buildIndex,
  countPending,
  countPendingStatuses,
  createDraftIndexCache,
  forgetDrafts,
  noteDraftStatus,
  syncStatuses,
} from './issue-draft-index.js';

/**
 * bdboard-vsuc: 索引の未処理件数の数え方 (countPendingStatuses)・version・forget・突き合わせ (syncStatuses) と、
 * 件数の問い合わせ専用の欠けた索引の使い回し (getForCount)。issue-draft-index.test.ts は seed の話なので別ファイル。
 */

const ID_A = '1758812345678-aaaaaaaaaaaaaaaa';
const ID_B = '1758812345679-bbbbbbbbbbbbbbbb';
const ID_C = '1758812345680-cccccccccccccccc';

function makeDraft(id: string, status: DraftStatus, fingerprint: string, firstOccurredAt = '2026-10-01T00:00:00.000Z'): IssueDraft {
  return {
    draftSchemaVersion: 1,
    id,
    kind: 'A',
    fingerprint,
    status,
    title: 'title',
    body: 'body',
    titleEditedByUser: false,
    bodyEditedByUser: false,
    localOnly: { symptomRaw: '', causeRaw: '', preventionRaw: '', errorTextTruncated: false, envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' } },
    occurredProjects: [],
    occurrenceCount: 1,
    firstOccurredAt,
    lastOccurredAt: firstOccurredAt,
  };
}

const pendingA = makeDraft(ID_A, 'pending', 'fp-a');
const dismissedB = makeDraft(ID_B, 'dismissed', 'fp-b', '2026-10-02T00:00:00.000Z');

function freshIndex() {
  return buildIndex([pendingA, dismissedB]);
}

describe('countPendingStatuses', () => {
  it('counts only pending, for any iterable, and is the one counting rule of the index', () => {
    expect(countPendingStatuses([])).toBe(0);
    expect(countPendingStatuses(['pending', 'posted', 'dismissed', 'pending'])).toBe(2);
    expect(countPendingStatuses(new Set<DraftStatus>(['dismissed', 'posted']))).toBe(0);
    expect(countPendingStatuses(new Map<string, DraftStatus>([['x', 'pending']]).values())).toBe(1);
    expect(countPending(freshIndex())).toBe(1);
  });
});

describe('draft index version', () => {
  it('starts at 0 and goes up by one for every status write, but not for a read', () => {
    const index = freshIndex();
    expect(index.version).toBe(0);
    countPending(index);
    expect(index.version).toBe(0);
    noteDraftStatus(index, makeDraft(ID_B, 'pending', 'fp-b'));
    expect(index.version).toBe(1);
    noteDraftStatus(index, makeDraft(ID_C, 'pending', 'fp-c'));
    expect(index.version).toBe(2);
    expect(countPending(index)).toBe(3);
  });
});

describe('forgetDrafts', () => {
  it('drops the status and every fingerprint entry of the ids, keeps entries that point at other ids, and bumps version once', () => {
    const index = freshIndex();
    index.idByFingerprint.set('fp-a-alias', ID_A);
    forgetDrafts(index, [ID_A]);
    expect(index.statusById.has(ID_A)).toBe(false);
    expect(index.idByFingerprint.has('fp-a')).toBe(false);
    expect(index.idByFingerprint.has('fp-a-alias')).toBe(false);
    expect(index.statusById.get(ID_B)).toBe('dismissed');
    expect(index.idByFingerprint.get('fp-b')).toBe(ID_B);
    expect(index.version).toBe(1);
  });

  it('takes any iterable of ids (a Set from the retention) and does nothing, not even a version bump, for no ids', () => {
    const index = freshIndex();
    forgetDrafts(index, []);
    forgetDrafts(index, new Set<string>());
    expect(index.version).toBe(0);
    expect([...index.statusById.keys()]).toEqual([ID_A, ID_B]);
    forgetDrafts(index, new Set([ID_A, ID_B]));
    expect(index.statusById.size).toBe(0);
    expect(index.idByFingerprint.size).toBe(0);
    expect(index.version).toBe(1);
  });

  it('bumps version for any non-empty ids, even ones the index does not hold (nothing else changes)', () => {
    const index = freshIndex();
    forgetDrafts(index, [ID_C]);
    expect(index.statusById.size).toBe(2);
    expect(index.version).toBe(1);
  });
});

describe('syncStatuses', () => {
  it('follows a complete listing: drops ids that are gone, adds ids that appeared, takes the listed status, and keeps version', () => {
    const index = freshIndex();
    syncStatuses(index, [
      { id: ID_A, status: 'dismissed' },
      { id: ID_C, status: 'pending' },
    ]);
    expect([...index.statusById]).toEqual([
      [ID_A, 'dismissed'],
      [ID_C, 'pending'],
    ]);
    expect(index.version).toBe(0);
    expect(countPending(index)).toBe(1);
  });

  it('leaves the fingerprint pointers and the hourly counts alone (they are not statuses)', () => {
    const index = freshIndex();
    const before = { fingerprints: [...index.idByFingerprint], hours: [...index.newDraftsByHour] };
    syncStatuses(index, []);
    expect(index.statusById.size).toBe(0);
    expect([...index.idByFingerprint]).toEqual(before.fingerprints);
    expect([...index.newDraftsByHour]).toEqual(before.hours);
  });
});

function scanning(listings: DraftListing[]) {
  let call = 0;
  return { scan: vi.fn(async () => listings[Math.min(call++, listings.length - 1)]) };
}

describe('DraftIndexCache.forget', () => {
  it('drops the ids from a loaded index and does not read anything when no index was loaded', async () => {
    const storage = scanning([{ drafts: [pendingA, dismissedB], complete: true }]);
    const cache = createDraftIndexCache(storage);
    await cache.forget(new Set([ID_A]));
    expect(storage.scan).not.toHaveBeenCalled();
    const index = await cache.get();
    await cache.forget(new Set([ID_A]));
    expect(index.statusById.has(ID_A)).toBe(false);
    expect(index.idByFingerprint.has('fp-a')).toBe(false);
    expect(await cache.loaded()).toBe(index);
  });

  it('waits for an index that is still loading and then drops the ids', async () => {
    const storage = scanning([{ drafts: [pendingA, dismissedB], complete: true }]);
    const cache = createDraftIndexCache(storage);
    const loading = cache.get();
    await cache.forget(new Set([ID_B]));
    expect((await loading).statusById.has(ID_B)).toBe(false);
  });

  it('never throws, even when the index failed to load', async () => {
    const failing = createDraftIndexCache({
      scan: vi.fn(async () => {
        throw new Error('scan failed');
      }),
    });
    const loading = failing.get();
    await expect(failing.forget(new Set([ID_A]))).resolves.toBeUndefined();
    await expect(loading).rejects.toThrow('scan failed');
    await expect(failing.forget(new Set([ID_A]))).resolves.toBeUndefined();
  });
});

describe('DraftIndexCache.getForCount', () => {
  const incomplete: DraftListing = { drafts: [pendingA], complete: false };
  const complete: DraftListing = { drafts: [pendingA, dismissedB], complete: true };

  it('returns the cached complete index without reading again', async () => {
    const storage = scanning([complete]);
    const cache = createDraftIndexCache(storage, { now: () => 1_000 });
    const index = await cache.getForCount();
    expect(await cache.getForCount()).toBe(index);
    expect(await cache.get()).toBe(index);
    expect(storage.scan).toHaveBeenCalledTimes(1);
  });

  it('reuses an incomplete index for 30 seconds of the injected clock, then reads again, and the new one is reused in turn', async () => {
    expect(INCOMPLETE_INDEX_COUNT_REUSE_MS).toBe(30_000);
    let now = 1_000;
    const storage = scanning([incomplete]);
    const cache = createDraftIndexCache(storage, { now: () => now });
    const first = await cache.getForCount();
    now += 29_999;
    expect(await cache.getForCount()).toBe(first);
    expect(storage.scan).toHaveBeenCalledTimes(1);
    now += 1; // ちょうど 30 秒は使い回さない
    const second = await cache.getForCount();
    expect(second).not.toBe(first);
    expect(storage.scan).toHaveBeenCalledTimes(2);
    now += 29_999;
    expect(await cache.getForCount()).toBe(second);
    expect(storage.scan).toHaveBeenCalledTimes(2);
  });

  it('honors incompleteReuseMs', async () => {
    let now = 0;
    const storage = scanning([incomplete]);
    const cache = createDraftIndexCache(storage, { now: () => now, incompleteReuseMs: 5 });
    await cache.getForCount();
    now = 4;
    await cache.getForCount();
    expect(storage.scan).toHaveBeenCalledTimes(1);
    now = 5;
    await cache.getForCount();
    expect(storage.scan).toHaveBeenCalledTimes(2);
  });

  it('does not reuse an incomplete index when the clock went backwards', async () => {
    let now = 100_000;
    const storage = scanning([incomplete]);
    const cache = createDraftIndexCache(storage, { now: () => now });
    await cache.getForCount();
    now = 50_000;
    await cache.getForCount();
    expect(storage.scan).toHaveBeenCalledTimes(2);
  });

  it('reuses the incomplete index that get() (the receive) built, which already has the receive writes', async () => {
    const storage = scanning([incomplete]);
    const cache = createDraftIndexCache(storage, { now: () => 1_000 });
    const fromReceive = await cache.get();
    noteDraftStatus(fromReceive, makeDraft(ID_C, 'pending', 'fp-c'));
    const counted = await cache.getForCount();
    expect(counted).toBe(fromReceive);
    expect(countPending(counted)).toBe(2);
    expect(storage.scan).toHaveBeenCalledTimes(1);
  });

  it('keeps get() reading every time while the listing is incomplete (the receive must not create a known draft twice)', async () => {
    const storage = scanning([incomplete]);
    const cache = createDraftIndexCache(storage, { now: () => 1_000 });
    const first = await cache.get();
    const second = await cache.get();
    expect(second).not.toBe(first);
    expect(storage.scan).toHaveBeenCalledTimes(2);
    await cache.getForCount(); // 件数の問い合わせは get() が覚えた索引を使う
    expect(storage.scan).toHaveBeenCalledTimes(2);
    expect(await cache.loaded()).toBeUndefined();
  });

  it('drops the remembered incomplete index once a complete one is cached', async () => {
    let now = 1_000;
    const storage = scanning([incomplete, complete]);
    const cache = createDraftIndexCache(storage, { now: () => now });
    const partial = await cache.getForCount();
    const full = await cache.get(); // 2 回目の scan は完全 -> キャッシュされる
    expect(full).not.toBe(partial);
    expect(await cache.getForCount()).toBe(full);
    now += 60_000;
    expect(await cache.getForCount()).toBe(full);
    expect(storage.scan).toHaveBeenCalledTimes(2);
  });

  it('drops the remembered incomplete index when a complete seed arrives', async () => {
    const storage = scanning([incomplete]);
    const cache = createDraftIndexCache(storage, { now: () => 1_000 });
    const partial = await cache.getForCount();
    cache.seed({ entries: [pendingA, dismissedB], complete: true });
    const seeded = await cache.getForCount();
    expect(seeded).not.toBe(partial);
    expect(countPending(seeded)).toBe(1);
    expect(storage.scan).toHaveBeenCalledTimes(1);
  });

  it('does not remember an index when the read fails, and reads again on the next call', async () => {
    const scan = vi.fn<() => Promise<DraftListing>>().mockRejectedValueOnce(new Error('scan failed')).mockResolvedValue(complete);
    const cache = createDraftIndexCache({ scan }, { now: () => 1_000 });
    await expect(cache.getForCount()).rejects.toThrow('scan failed');
    expect(countPending(await cache.getForCount())).toBe(1);
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
