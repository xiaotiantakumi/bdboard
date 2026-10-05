import { describe, expect, it, vi } from 'vitest';
import { createDraftIndexCache, buildIndex } from './issue-draft-index.js';
import type { DraftIndexEntry } from '../ports/issue-draft-storage.js';

const entries: DraftIndexEntry[] = [
  { id: '1758812345678-aaaaaaaaaaaaaaaa', fingerprint: 'same', firstOccurredAt: '2026-10-01T00:00:00.000Z', status: 'pending' },
  { id: '1758812345679-bbbbbbbbbbbbbbbb', fingerprint: 'same', firstOccurredAt: '2026-10-02T00:00:00.000Z', status: 'dismissed' },
];

function scanningStorage() {
  return { scan: vi.fn(() => Promise.resolve({ drafts: [], complete: true })) };
}

describe('createDraftIndexCache seed', () => {
  it('uses a complete seed without scanning and skips removed ids', async () => {
    const storage = scanningStorage();
    const cache = createDraftIndexCache(storage);
    cache.seed({ entries, complete: true }, new Set([entries[1].id]));
    const index = await cache.get();
    expect(storage.scan).not.toHaveBeenCalled();
    expect(index.idByFingerprint.get('same')).toBe(entries[0].id);
    expect(index.statusById.has(entries[1].id)).toBe(false);
    expect(index.newDraftsByHour.size).toBe(1);
    expect(await cache.loaded()).toBe(index);
  });

  it('does not cache incomplete seeds and does not replace an existing index', async () => {
    const storage = scanningStorage();
    const cache = createDraftIndexCache(storage);
    cache.seed({ entries, complete: false });
    await cache.get();
    expect(storage.scan).toHaveBeenCalledTimes(1);
    const loaded = await cache.get();
    cache.seed({ entries, complete: true });
    expect(await cache.get()).toBe(loaded);
    expect(storage.scan).toHaveBeenCalledTimes(1);
  });

  it('uses the later first occurrence for duplicate fingerprints and rejects an invalid seed safely', async () => {
    const storage = scanningStorage();
    expect(buildIndex(entries).idByFingerprint.get('same')).toBe(entries[1].id);
    const invalid = [{ ...entries[0], firstOccurredAt: 'not-a-date' }];
    const cache = createDraftIndexCache(storage);
    cache.seed({ entries: invalid, complete: true });
    await cache.get();
    expect(storage.scan).toHaveBeenCalledTimes(1);
  });
});

describe('buildIndex: the automatic per-hour count', () => {
  it('counts automatic drafts only: neither mass-occurrence nor manual drafts (bdboard-4y8q.6.7) use the automatic slot', () => {
    const at = '2026-10-01T00:30:00.000Z';
    const index = buildIndex([
      { id: '1758812345001-aaaaaaaaaaaaaaaa', fingerprint: 'A:slug-a', firstOccurredAt: at, status: 'pending' },
      { id: '1758812345002-bbbbbbbbbbbbbbbb', fingerprint: 'mass-occurrence:A:2026-10-01T00', firstOccurredAt: at, status: 'pending' },
      { id: '1758812345003-cccccccccccccccc', fingerprint: 'C:manual:a1b2c3d4e5f6a7b8', firstOccurredAt: at, status: 'pending' },
      { id: '1758812345004-dddddddddddddddd', fingerprint: 'C:manual:0011223344556677', firstOccurredAt: at, status: 'dismissed' },
    ]);
    expect([...index.newDraftsByHour.entries()]).toEqual([['2026-10-01T00', 1]]);
    // 状態の索引には全部入る (未処理の件数は手書きも数える)。
    expect(index.statusById.size).toBe(4);
  });
});
