import { describe, expect, it, vi } from 'vitest';
import type { PrStatusResult } from '../ports/pr-status-reader.js';
import { PrBadgeStatusCache } from './pr-badge-status-cache.js';

const MERGED_PASS = { state: 'merged', checkStatus: 'pass' } as const;
const CLOSED_FAIL = { state: 'closed', checkStatus: 'fail' } as const;
const OPEN_PASS = { state: 'open', checkStatus: 'pass' } as const;
const MERGED_PENDING = { state: 'merged', checkStatus: 'pending' } as const;

function resultOf(status: PrStatusResult['status']): () => Promise<PrStatusResult> {
  if (status === null) {
    return () => Promise.resolve({ status: null, reason: 'other' });
  }
  return () => Promise.resolve({ status });
}

describe('PrBadgeStatusCache — bdboard-ye2p persistence surface', () => {
  describe('getTerminalEntries selection (非 terminal は保存しない)', () => {
    it('is empty for a cache with no entries', () => {
      const cache = new PrBadgeStatusCache();
      expect(cache.getTerminalEntries()).toEqual([]);
    });

    it('excludes an open PR (not terminal)', async () => {
      const cache = new PrBadgeStatusCache({ now: () => 1_000 });
      await cache.fetchStatus('u1', resultOf(OPEN_PASS)).promise;
      expect(cache.getTerminalEntries()).toEqual([]);
    });

    it('excludes a merged+pending PR before it reaches the max retry count', async () => {
      const cache = new PrBadgeStatusCache({ now: () => 1_000, mergedPendingMaxRetries: 3 });
      await cache.fetchStatus('u1', resultOf(MERGED_PENDING)).promise;
      expect(cache.getTerminalEntries()).toEqual([]);
    });

    it('excludes a negative-cache (failure) entry', async () => {
      const cache = new PrBadgeStatusCache({ now: () => 1_000 });
      await cache.fetchStatus('u1', resultOf(null)).promise;
      expect(cache.getTerminalEntries()).toEqual([]);
    });

    it('includes a merged/pass entry (fully terminal)', async () => {
      const cache = new PrBadgeStatusCache({ now: () => 1_234 });
      await cache.fetchStatus('u1', resultOf(MERGED_PASS)).promise;
      expect(cache.getTerminalEntries()).toEqual([
        { url: 'u1', status: MERGED_PASS, fetchedAt: 1_234, mergedPendingRetries: 0 },
      ]);
    });

    it('includes a closed/fail entry (fully terminal)', async () => {
      const cache = new PrBadgeStatusCache({ now: () => 5_000 });
      await cache.fetchStatus('u1', resultOf(CLOSED_FAIL)).promise;
      expect(cache.getTerminalEntries()).toEqual([
        { url: 'u1', status: CLOSED_FAIL, fetchedAt: 5_000, mergedPendingRetries: 0 },
      ]);
    });

    it('includes a merged+pending entry once it hits mergedPendingMaxRetries (恒久化)', async () => {
      let fakeNow = 0;
      const cache = new PrBadgeStatusCache({
        now: () => fakeNow,
        mergedPendingTtlMs: 1,
        mergedPendingMaxRetries: 2,
      });
      await cache.fetchStatus('u1', resultOf(MERGED_PENDING)).promise;
      expect(cache.getTerminalEntries()).toEqual([]);

      fakeNow = 10;
      await cache.fetchStatus('u1', resultOf(MERGED_PENDING)).promise;
      expect(cache.getTerminalEntries()).toEqual([
        { url: 'u1', status: MERGED_PENDING, fetchedAt: 10, mergedPendingRetries: 2 },
      ]);
    });
  });

  describe('initialEntries (起動時ロード)', () => {
    it('seeds get() so a restored URL resolves without any fetch', () => {
      const cache = new PrBadgeStatusCache({
        initialEntries: [
          { url: 'u1', status: MERGED_PASS, fetchedAt: 0, mergedPendingRetries: 0 },
        ],
      });
      expect(cache.get('u1')).toEqual(MERGED_PASS);
      expect(cache.isInFlight('u1')).toBe(false);
    });

    it('restored entries round-trip back out via getTerminalEntries', () => {
      const entry = { url: 'u1', status: CLOSED_FAIL, fetchedAt: 42, mergedPendingRetries: 3 };
      const cache = new PrBadgeStatusCache({ initialEntries: [entry] });
      expect(cache.getTerminalEntries()).toEqual([entry]);
    });

    it('ignores an entry with an invalid state (corrupted file, defensive)', () => {
      const cache = new PrBadgeStatusCache({
        initialEntries: [
          // @ts-expect-error -- deliberately malformed, mirrors a corrupted JSON file
          { url: 'bad', status: { state: 'bogus', checkStatus: 'pass' }, fetchedAt: 0, mergedPendingRetries: 0 },
        ],
      });
      expect(cache.get('bad')).toBeUndefined();
      expect(cache.getTerminalEntries()).toEqual([]);
    });

    it('ignores an entry whose state is open (permanent never happens for open PRs)', () => {
      const cache = new PrBadgeStatusCache({
        initialEntries: [{ url: 'bad', status: OPEN_PASS, fetchedAt: 0, mergedPendingRetries: 0 }],
      });
      expect(cache.get('bad')).toBeUndefined();
    });

    it('ignores an entry with a non-finite fetchedAt', () => {
      const cache = new PrBadgeStatusCache({
        initialEntries: [
          { url: 'bad', status: MERGED_PASS, fetchedAt: Number.NaN, mergedPendingRetries: 0 },
        ],
      });
      expect(cache.get('bad')).toBeUndefined();
    });

    it('ignores a non-object entry without throwing', () => {
      const cache = new PrBadgeStatusCache({
        // @ts-expect-error -- deliberately malformed, mirrors a corrupted JSON file
        initialEntries: [null, 'not-an-entry', 42],
      });
      expect(cache.getTerminalEntries()).toEqual([]);
    });

    it('keeps valid entries alongside invalid ones instead of rejecting the whole batch', () => {
      const cache = new PrBadgeStatusCache({
        initialEntries: [
          { url: 'good', status: MERGED_PASS, fetchedAt: 1, mergedPendingRetries: 0 },
          // @ts-expect-error -- deliberately malformed
          { url: 'bad', status: { state: 'bogus' }, fetchedAt: 1, mergedPendingRetries: 0 },
        ],
      });
      expect(cache.get('good')).toEqual(MERGED_PASS);
      expect(cache.get('bad')).toBeUndefined();
    });
  });

  describe('onPersistableChange notification', () => {
    it('fires exactly once when a URL first becomes terminal', async () => {
      const onPersistableChange = vi.fn();
      const cache = new PrBadgeStatusCache({ now: () => 1_000, onPersistableChange });

      await cache.fetchStatus('u1', resultOf(MERGED_PASS)).promise;

      expect(onPersistableChange).toHaveBeenCalledTimes(1);
    });

    it('does not fire for a non-terminal (open) result', async () => {
      const onPersistableChange = vi.fn();
      const cache = new PrBadgeStatusCache({ now: () => 1_000, onPersistableChange });

      await cache.fetchStatus('u1', resultOf(OPEN_PASS)).promise;

      expect(onPersistableChange).not.toHaveBeenCalled();
    });

    it('does not fire for a failed fetch', async () => {
      const onPersistableChange = vi.fn();
      const cache = new PrBadgeStatusCache({ now: () => 1_000, onPersistableChange });

      await cache.fetchStatus('u1', resultOf(null)).promise;

      expect(onPersistableChange).not.toHaveBeenCalled();
    });

    it('does not fire again on a later re-fetch of an already-permanent URL', async () => {
      const onPersistableChange = vi.fn();
      const cache = new PrBadgeStatusCache({ now: () => 1_000, onPersistableChange });

      await cache.fetchStatus('u1', resultOf(MERGED_PASS)).promise;
      expect(onPersistableChange).toHaveBeenCalledTimes(1);

      // 呼び出し元は通常 get() で先に弾くので実運用では起きないが、直接
      // fetchStatus を呼び直しても二重通知しないことを保証しておく。
      await cache.fetchStatus('u1', resultOf(MERGED_PASS)).promise;
      expect(onPersistableChange).toHaveBeenCalledTimes(1);
    });

    it('fires only on the retry that crosses mergedPendingMaxRetries, not the earlier ones', async () => {
      const onPersistableChange = vi.fn();
      let fakeNow = 0;
      const cache = new PrBadgeStatusCache({
        now: () => fakeNow,
        onPersistableChange,
        mergedPendingTtlMs: 1,
        mergedPendingMaxRetries: 3,
      });

      await cache.fetchStatus('u1', resultOf(MERGED_PENDING)).promise;
      expect(onPersistableChange).not.toHaveBeenCalled();

      fakeNow = 10;
      await cache.fetchStatus('u1', resultOf(MERGED_PENDING)).promise;
      expect(onPersistableChange).not.toHaveBeenCalled();

      fakeNow = 20;
      await cache.fetchStatus('u1', resultOf(MERGED_PENDING)).promise;
      expect(onPersistableChange).toHaveBeenCalledTimes(1);
    });

    it('is never invoked when omitted from the options (backward compatible)', async () => {
      const cache = new PrBadgeStatusCache({ now: () => 1_000 });
      await expect(cache.fetchStatus('u1', resultOf(MERGED_PASS)).promise).resolves.toBeDefined();
      expect(cache.getTerminalEntries()).toHaveLength(1);
    });
  });
});
