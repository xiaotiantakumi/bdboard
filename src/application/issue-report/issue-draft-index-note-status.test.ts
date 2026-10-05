import { describe, expect, it, vi } from 'vitest';
import type { DraftStatus, IssueDraft } from '../../domain/issue-draft.js';
import type { DraftListing } from '../ports/issue-draft-storage.js';
import { countPending, createDraftIndexCache } from './issue-draft-index.js';

/**
 * bdboard-ov0t (#892 の再レビューの任意): DraftIndexCache.noteStatus は、読み込み済み・読み込み中の索引か、getForCount が使い回す
 * 欠けた索引へ状態を書くだけで、自分では保存済みの下書きを読まない (scan も get() も起こさない)。
 */

const ID_A = '1758812345678-aaaaaaaaaaaaaaaa';
const ID_B = '1758812345679-bbbbbbbbbbbbbbbb';

function makeDraft(id: string, status: DraftStatus, fingerprint: string): IssueDraft {
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
    firstOccurredAt: '2026-10-01T00:00:00.000Z',
    lastOccurredAt: '2026-10-01T00:00:00.000Z',
  };
}

const pendingA = makeDraft(ID_A, 'pending', 'fp-a');
const pendingB = makeDraft(ID_B, 'pending', 'fp-b');

function scanning(listing: DraftListing) {
  return { scan: vi.fn(() => Promise.resolve(listing)) };
}

describe('DraftIndexCache.noteStatus does not load anything', () => {
  it('does not scan when no index was loaded, and a later get() still reads once', async () => {
    const storage = scanning({ drafts: [pendingA], complete: true });
    const cache = createDraftIndexCache(storage);
    await cache.noteStatus({ ...pendingA, status: 'dismissed' });
    expect(storage.scan).not.toHaveBeenCalled();
    expect(await cache.loaded()).toBeUndefined();
    const index = await cache.get();
    expect(storage.scan).toHaveBeenCalledTimes(1);
    expect(index.statusById.get(ID_A)).toBe('pending'); // 読む前の noteStatus は、どこにも残らない
  });

  it('writes into a loaded index without reading again', async () => {
    const storage = scanning({ drafts: [pendingA, pendingB], complete: true });
    const cache = createDraftIndexCache(storage);
    const index = await cache.get();
    await cache.noteStatus({ ...pendingA, status: 'dismissed' });
    expect(storage.scan).toHaveBeenCalledTimes(1);
    expect(index.statusById.get(ID_A)).toBe('dismissed');
    expect(countPending(index)).toBe(1);
    expect(index.version).toBe(1);
  });

  it('waits for an index that is still loading and writes into it, with one read', async () => {
    const storage = scanning({ drafts: [pendingA, pendingB], complete: true });
    const cache = createDraftIndexCache(storage);
    const loading = cache.get();
    await cache.noteStatus({ ...pendingB, status: 'dismissed' });
    expect(storage.scan).toHaveBeenCalledTimes(1);
    expect(countPending(await loading)).toBe(1);
  });

  it('writes into the incomplete index that getForCount reuses, without reading again', async () => {
    const storage = scanning({ drafts: [pendingA, pendingB], complete: false });
    const cache = createDraftIndexCache(storage, { now: () => 1_000 });
    const partial = await cache.getForCount();
    expect(storage.scan).toHaveBeenCalledTimes(1);
    await cache.noteStatus({ ...pendingA, status: 'dismissed' });
    expect(storage.scan).toHaveBeenCalledTimes(1);
    expect(await cache.getForCount()).toBe(partial);
    expect(countPending(partial)).toBe(1);
    expect(storage.scan).toHaveBeenCalledTimes(1);
  });
});
