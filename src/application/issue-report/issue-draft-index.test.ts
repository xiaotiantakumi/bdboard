import { describe, expect, it, vi } from 'vitest';
import { createDraftIndexCache, buildIndex } from './issue-draft-index.js';
import type { DraftIndexEntry } from '../ports/issue-draft-storage.js';

const entries: DraftIndexEntry[] = [
  { id: '1758812345678-aaaaaaaaaaaaaaaa', fingerprint: 'same', firstOccurredAt: '2026-10-01T00:00:00.000Z', status: 'pending' },
  { id: '1758812345679-bbbbbbbbbbbbbbbb', fingerprint: 'same', firstOccurredAt: '2026-10-02T00:00:00.000Z', status: 'dismissed' },
];

describe('createDraftIndexCache seed', () => {
  it('uses a complete seed without scanning and skips removed ids', async () => {
    const scan = vi.fn(async () => ({ drafts: [], complete: true }));
    const cache = createDraftIndexCache({ scan });
    cache.seed({ entries, complete: true }, new Set([entries[1]!.id]));
    const index = await cache.get();
    expect(scan).not.toHaveBeenCalled();
    expect(index.idByFingerprint.get('same')).toBe(entries[0]!.id);
    expect(index.statusById.has(entries[1]!.id)).toBe(false);
    expect(index.newDraftsByHour.size).toBe(1);
    expect(await cache.loaded()).toBe(index);
  });

  it('does not cache incomplete seeds and does not replace an existing index', async () => {
    const scan = vi.fn(async () => ({ drafts: [], complete: true }));
    const cache = createDraftIndexCache({ scan });
    cache.seed({ entries, complete: false });
    await cache.get();
    expect(scan).toHaveBeenCalledTimes(1);
    cache.seed({ entries, complete: true });
    expect(await cache.get()).toBe(await cache.loaded());
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('uses the later first occurrence for duplicate fingerprints and rejects an invalid seed safely', async () => {
    const scan = vi.fn(async () => ({ drafts: [], complete: true }));
    expect(buildIndex(entries).idByFingerprint.get('same')).toBe(entries[1]!.id);
    const invalid = [{ ...entries[0]!, firstOccurredAt: 'not-a-date' }];
    const cache = createDraftIndexCache({ scan });
    cache.seed({ entries: invalid, complete: true });
    await cache.get();
    expect(scan).toHaveBeenCalledTimes(1);
  });
});
