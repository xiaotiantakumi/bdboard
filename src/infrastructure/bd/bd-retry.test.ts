import { describe, expect, it, vi } from 'vitest';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  isLockContentionError,
  isTimeoutError,
  isTransientReadError,
  withLockContentionRetry,
  withRetry,
  withTransientReadRetry,
} from './bd-retry.js';

function noDelaySleep(): (delayMs: number) => Promise<void> {
  return () => Promise.resolve();
}

describe('withRetry', () => {
  it('returns the result immediately when the operation succeeds on the first try', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    const isRetryable = vi.fn().mockReturnValue(true);
    const sleep = vi.fn(noDelaySleep());

    const result = await withRetry(operation, isRetryable, { sleep });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries until success within the configured retry budget', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValueOnce('ok');
    const sleep = vi.fn(noDelaySleep());

    const result = await withRetry(operation, () => true, {
      retries: 2,
      sleep,
    });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws the last error once the retry budget is exhausted', async () => {
    const error = new Error('always fails');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(noDelaySleep());

    await expect(
      withRetry(operation, () => true, { retries: 2, sleep }),
    ).rejects.toBe(error);
    // 初回 + リトライ2回 = 最大3試行
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('rethrows immediately without sleeping when the error is not retryable', async () => {
    const error = new Error('not retryable');
    const operation = vi.fn().mockRejectedValue(error);
    const isRetryable = vi.fn().mockReturnValue(false);
    const sleep = vi.fn(noDelaySleep());

    await expect(
      withRetry(operation, isRetryable, { retries: 2, sleep }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry at all when retries is 0', async () => {
    const error = new Error('fails once');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(noDelaySleep());

    await expect(
      withRetry(operation, () => true, { retries: 0, sleep }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('passes an increasing delay to sleep on each retry (exponential backoff)', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValueOnce('ok');
    const delays: number[] = [];
    const sleep = vi.fn(async (delayMs: number) => {
      delays.push(delayMs);
    });

    await withRetry(operation, () => true, {
      retries: 2,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      jitterRatio: 0,
      sleep,
    });

    expect(delays).toEqual([100, 200]);
  });

  it('caps the delay at maxDelayMs', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockResolvedValueOnce('ok');
    const delays: number[] = [];
    const sleep = vi.fn(async (delayMs: number) => {
      delays.push(delayMs);
    });

    await withRetry(operation, () => true, {
      retries: 1,
      baseDelayMs: 1_000,
      maxDelayMs: 50,
      jitterRatio: 0,
      sleep,
    });

    expect(delays).toEqual([50]);
  });
});

describe('isLockContentionError', () => {
  it('returns true only for a BdError with kind lock-contention', () => {
    expect(
      isLockContentionError(new BdError('lock-contention', 'p', 'locked')),
    ).toBe(true);
    expect(
      isLockContentionError(new BdError('unknown', 'p', 'something else')),
    ).toBe(false);
    expect(isLockContentionError(new Error('plain error'))).toBe(false);
    expect(isLockContentionError('not an error')).toBe(false);
  });
});

describe('withLockContentionRetry', () => {
  it('retries lock-contention BdErrors and returns the eventual success', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new BdError('lock-contention', 'p', 'locked'))
      .mockResolvedValueOnce('ok');
    const sleep = vi.fn(noDelaySleep());

    const result = await withLockContentionRetry(operation, { sleep });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-lock-contention BdError', async () => {
    const error = new BdError('bd-not-found', 'p', 'no bd');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(noDelaySleep());

    await expect(withLockContentionRetry(operation, { sleep })).rejects.toBe(
      error,
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

// bdboard-vpt3: 健全性/リース回収での断続的な context canceled タイムアウトの
// 緩和策として、lock-contention に加えて timeout も短期リトライの対象にした。
describe('isTimeoutError', () => {
  it('returns true only for a BdError with kind timeout', () => {
    expect(isTimeoutError(new BdError('timeout', 'p', 'context canceled'))).toBe(
      true,
    );
    expect(isTimeoutError(new BdError('unknown', 'p', 'something else'))).toBe(
      false,
    );
    expect(isTimeoutError(new Error('plain error'))).toBe(false);
    expect(isTimeoutError('not an error')).toBe(false);
  });
});

describe('isTransientReadError', () => {
  it('returns true for lock-contention or timeout, false otherwise', () => {
    expect(
      isTransientReadError(new BdError('lock-contention', 'p', 'locked')),
    ).toBe(true);
    expect(
      isTransientReadError(new BdError('timeout', 'p', 'context canceled')),
    ).toBe(true);
    expect(
      isTransientReadError(new BdError('bd-not-found', 'p', 'no bd')),
    ).toBe(false);
  });
});

describe('withTransientReadRetry', () => {
  it('retries a timeout BdError and returns the eventual success', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new BdError('timeout', 'p', 'context canceled'))
      .mockResolvedValueOnce('ok');
    const sleep = vi.fn(noDelaySleep());

    const result = await withTransientReadRetry(operation, { sleep });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries a lock-contention BdError too', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new BdError('lock-contention', 'p', 'locked'))
      .mockResolvedValueOnce('ok');
    const sleep = vi.fn(noDelaySleep());

    const result = await withTransientReadRetry(operation, { sleep });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient BdError', async () => {
    const error = new BdError('bd-not-found', 'p', 'no bd');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(noDelaySleep());

    await expect(withTransientReadRetry(operation, { sleep })).rejects.toBe(
      error,
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('defaults to a single retry (max 2 attempts) so a full-timeout retry cannot stack up 90s', async () => {
    // 1 試行が timeoutMs (既定30秒) までかかりうるので、lock-contention 用の
    // 既定 retries:2 をそのまま使うと最悪 3 試行 x 30秒 になる。ここでは既定
    // retries が 1 (最大2試行) であることを、明示指定なしの呼び出しで確認する。
    const error = new BdError('timeout', 'p', 'context canceled');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(noDelaySleep());

    await expect(withTransientReadRetry(operation, { sleep })).rejects.toBe(
      error,
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('lets the caller override the default retry budget', async () => {
    const error = new BdError('timeout', 'p', 'context canceled');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(noDelaySleep());

    await expect(
      withTransientReadRetry(operation, { retries: 0, sleep }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
