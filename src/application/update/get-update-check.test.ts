import { describe, expect, it, vi } from 'vitest';
import type { LatestRelease } from '../../domain/update-check.js';
import type { ReleaseSource } from '../ports/release-source.js';
import { createUpdateCheckService } from './get-update-check.js';

const RELEASE: LatestRelease = {
  tag: 'v2.0.0',
  url: 'https://github.com/xiaotiantakumi/bdboard/releases/tag/v2.0.0',
};

function fixedClock(startMs: number) {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function createService(
  source: ReleaseSource,
  overrides?: { ttlMs?: number; enabled?: boolean; version?: string },
) {
  const clock = fixedClock(1_000_000);
  const service = createUpdateCheckService({
    applicationVersion: { getVersion: () => overrides?.version ?? '1.0.0' },
    source,
    now: clock.now,
    ...(overrides?.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
    ...(overrides?.enabled !== undefined ? { enabled: overrides.enabled } : {}),
  });
  return { service, clock };
}

describe('createUpdateCheckService', () => {
  it('reports an available update from the source', async () => {
    const { service } = createService({ fetchLatest: async () => RELEASE });

    await expect(service.getUpdateCheck()).resolves.toEqual({
      kind: 'update-available',
      currentVersion: '1.0.0',
      latestVersion: 'v2.0.0',
      releaseUrl: RELEASE.url,
    });
  });

  it('caches within the ttl and refetches after it expires', async () => {
    const fetchLatest = vi.fn(async () => RELEASE);
    const { service, clock } = createService({ fetchLatest }, { ttlMs: 60_000 });

    await service.getUpdateCheck();
    clock.advance(59_999);
    await service.getUpdateCheck();
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    clock.advance(1);
    await service.getUpdateCheck();
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a negative ttl', -1],
    ['NaN (an unparsable BDBOARD_UPDATE_CHECK_CACHE_MS)', Number.NaN],
  ])('falls back to the default ttl for %s instead of disabling the cache', async (
    _label,
    ttlMs,
  ) => {
    // 設定ミスで鮮度判定が常に false になると、リクエストごとに GitHub を叩いて
    // 未認証の 60 req/h を使い切る。既定 (6時間) に戻ることを固定する
    // (PR#112 fable レビュー nit)。
    const fetchLatest = vi.fn(async () => RELEASE);
    const { service, clock } = createService({ fetchLatest }, { ttlMs });

    await service.getUpdateCheck();
    clock.advance(6 * 60 * 60 * 1000 - 1);
    await service.getUpdateCheck();
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    clock.advance(1);
    await service.getUpdateCheck();
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent calls into a single fetch', async () => {
    // 未認証の GitHub API は IP あたり 60 req/h しかない。タブを複数開いた程度で
    // 使い切らないよう、同時リクエストは1回にまとめる。
    let resolveFetch: ((value: LatestRelease) => void) | undefined;
    const fetchLatest = vi.fn(
      () =>
        new Promise<LatestRelease>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { service } = createService({ fetchLatest });

    const first = service.getUpdateCheck();
    const second = service.getUpdateCheck();
    resolveFetch?.(RELEASE);

    await expect(first).resolves.toMatchObject({ kind: 'update-available' });
    await expect(second).resolves.toMatchObject({ kind: 'update-available' });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('is unknown when the source cannot answer, and caches that too', async () => {
    // オフライン環境で毎リクエストごとにタイムアウト分待たせない。
    const fetchLatest = vi.fn(async () => null);
    const { service, clock } = createService({ fetchLatest }, { ttlMs: 60_000 });

    await expect(service.getUpdateCheck()).resolves.toEqual({
      kind: 'unknown',
      currentVersion: '1.0.0',
    });
    clock.advance(30_000);
    await service.getUpdateCheck();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('does not propagate an exception thrown by the source', async () => {
    const { service } = createService({
      fetchLatest: async () => {
        throw new Error('boom');
      },
    });

    await expect(service.getUpdateCheck()).resolves.toEqual({
      kind: 'unknown',
      currentVersion: '1.0.0',
    });
  });

  it('recovers on the next call after a thrown error (the in-flight promise is cleared)', async () => {
    const fetchLatest = vi
      .fn<() => Promise<LatestRelease | null>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(RELEASE);
    const { service, clock } = createService({ fetchLatest }, { ttlMs: 60_000 });

    await service.getUpdateCheck();
    clock.advance(60_001);

    await expect(service.getUpdateCheck()).resolves.toMatchObject({
      kind: 'update-available',
    });
  });

  it('never touches the network when disabled', async () => {
    const fetchLatest = vi.fn(async () => RELEASE);
    const { service } = createService({ fetchLatest }, { enabled: false });

    await expect(service.getUpdateCheck()).resolves.toEqual({
      kind: 'unknown',
      currentVersion: '1.0.0',
    });
    expect(fetchLatest).not.toHaveBeenCalled();
  });
});
