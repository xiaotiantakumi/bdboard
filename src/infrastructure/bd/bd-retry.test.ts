import { describe, expect, it, vi } from 'vitest';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  isLockContentionError,
  withLockContentionRetry,
  withRetry,
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
