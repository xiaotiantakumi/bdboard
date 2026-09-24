import { describe, expect, it, vi } from 'vitest';
import type { SemaphorePriority } from '../concurrency.js';
import { PrBadgeStatusCache } from './pr-badge-status-cache.js';
import type { PrStatusResult } from '../ports/pr-status-reader.js';

// bdboard-gfqz round 3: fetchStatus() が「起動元だけでなく、後から同じ url に
// 相乗りした呼び出しの getPriority も合流させる」ことを直接検証する。この
// マージが無いと、相乗り呼び出し (alreadyInFlight===true, statusGate.acquire()
// を一切呼ばない) は自分の優先度を一切反映できず、フィルタ済みリクエストが
// 既に in-flight の (フィルタなしリクエスト由来の) 低優先度フェッチに相乗り
// するだけで詰まる — これが round 2 まで見落としていた欠落 (opus レビュー指摘)。

function neverResolves(): Promise<PrStatusResult> {
  return new Promise(() => {});
}

describe('PrBadgeStatusCache.fetchStatus: priority is merged across all interested callers (bdboard-gfqz round 3)', () => {
  it('passes a mergedGetPriority function to the launching fetcher, defaulting to the launcher\'s own priority when no one else has joined', async () => {
    const cache = new PrBadgeStatusCache();
    let capturedMerged: (() => SemaphorePriority) | undefined;
    const fetcher = vi.fn((getMergedPriority: () => SemaphorePriority) => {
      capturedMerged = getMergedPriority;
      return neverResolves();
    });

    cache.fetchStatus('https://example.com/pr/1', fetcher, () => 'low');

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(capturedMerged).toBeDefined();
    expect(capturedMerged!()).toBe('low');
  });

  it('a joiner registering high priority promotes the merged priority the launcher\'s fetcher sees, even though the joiner never calls the fetcher itself', async () => {
    const cache = new PrBadgeStatusCache();
    let capturedMerged: (() => SemaphorePriority) | undefined;
    const launchFetcher = vi.fn((getMergedPriority: () => SemaphorePriority) => {
      capturedMerged = getMergedPriority;
      return neverResolves();
    });
    const joinFetcher = vi.fn(() => neverResolves());

    const launch = cache.fetchStatus('https://example.com/pr/2', launchFetcher, () => 'low');
    expect(launch.launched).toBe(true);
    expect(capturedMerged!()).toBe('low');

    // 相乗り呼び出し: 同じ url に対して高優先度で興味を登録する。
    const join = cache.fetchStatus('https://example.com/pr/2', joinFetcher, () => 'high');
    expect(join.launched).toBe(false);
    expect(join.promise).toBe(launch.promise);
    // 相乗り側の fetcher は一切呼ばれない (bdboard-ksed の契約を維持)。
    expect(joinFetcher).not.toHaveBeenCalled();

    // 起動元の fetcher が受け取った mergedGetPriority は、相乗りが登録した
    // 'high' を反映して昇格する —— これが round 3 の核心。
    expect(capturedMerged!()).toBe('high');
  });

  it('reverts to low once the high-priority joiner would no longer report high (merged priority is re-read live, not snapshotted)', async () => {
    const cache = new PrBadgeStatusCache();
    let capturedMerged: (() => SemaphorePriority) | undefined;
    const launchFetcher = vi.fn((getMergedPriority: () => SemaphorePriority) => {
      capturedMerged = getMergedPriority;
      return neverResolves();
    });

    cache.fetchStatus('https://example.com/pr/3', launchFetcher, () => 'low');
    let joinerCurrentlyHigh = true;
    cache.fetchStatus('https://example.com/pr/3', () => neverResolves(), () => (joinerCurrentlyHigh ? 'high' : 'low'));

    expect(capturedMerged!()).toBe('high');
    joinerCurrentlyHigh = false;
    expect(capturedMerged!()).toBe('low');
  });

  it('a second launch for a different, unrelated url is unaffected by another url\'s joiners', async () => {
    const cache = new PrBadgeStatusCache();
    const capturedByUrl = new Map<string, () => SemaphorePriority>();
    const fetcherFor = (url: string) =>
      vi.fn((getMergedPriority: () => SemaphorePriority) => {
        capturedByUrl.set(url, getMergedPriority);
        return neverResolves();
      });

    cache.fetchStatus('https://example.com/pr/a', fetcherFor('a'), () => 'low');
    cache.fetchStatus('https://example.com/pr/b', fetcherFor('b'), () => 'low');
    cache.fetchStatus('https://example.com/pr/a', () => neverResolves(), () => 'high');

    expect(capturedByUrl.get('a')!()).toBe('high');
    expect(capturedByUrl.get('b')!()).toBe('low');
  });
});
