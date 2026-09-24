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

  it('caps repeated timeout failures at 2 attempts (1 retry) even with the default retries:2 budget', async () => {
    // 1 試行が timeoutMs (既定30秒) までかかりうるので、lock-contention 用の
    // 既定 retries:2 (最大3試行) をそのまま timeout にも使うと最悪 3 試行 x
    // 30秒になりうる。既定 retries は 2 のままだが (lock-contention の予算は
    // 減らさない、cf. 'keeps lock-contention on the full default retry
    // budget' 直下のテスト)、withTransientReadRetry 内部の timeoutRetryUsed
    // フラグが timeout 由来のリトライだけを高々1回に絞るので、timeout が
    // 繰り返しても最大2試行で打ち切られることを、明示指定なしの呼び出しで
    // 確認する。
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

  it('keeps lock-contention on the full default retry budget (2 retries = 3 attempts), unreduced by the timeout cap', async () => {
    // withTransientReadRetry は timeout 由来のリトライだけを高々1回に絞る。
    // lock-contention は従来どおり withLockContentionRetry と同じ既定
    // retries (2 = 最大3試行) をフルに使えることを、2連続の lock-contention
    // 失敗 + 3回目で成功、というシナリオで直接確認する (bdboard-vpt3 の
    // review で指摘された「timeout 対応の副作用で lock-contention の
    // リトライ予算が静かに減っていないか」を pin する)。
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new BdError('lock-contention', 'p', 'locked'))
      .mockRejectedValueOnce(new BdError('lock-contention', 'p', 'locked'))
      .mockResolvedValueOnce('ok');
    const sleep = vi.fn(noDelaySleep());

    const result = await withTransientReadRetry(operation, { sleep });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not let a timeout retry consume the lock-contention budget when kinds are interleaved', async () => {
    // lock-contention → timeout → lock-contention という混在シーケンスでも、
    // timeout 由来のリトライは高々1回に絞られたまま (2回目以降の timeout は
    // リトライされない) ことを確認する。
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new BdError('lock-contention', 'p', 'locked'))
      .mockRejectedValueOnce(new BdError('timeout', 'p', 'context canceled'))
      .mockRejectedValueOnce(new BdError('timeout', 'p', 'context canceled'));
    const sleep = vi.fn(noDelaySleep());

    await expect(
      withTransientReadRetry(operation, { sleep }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    // 1回目(lock-contention, retry) → 2回目(timeout, retry, 予算消費) →
    // 3回目(timeout, 予算使い切り済みなのでリトライせず投げ直す) = 3試行。
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('caps timeout retries at 1 even when the overall retries budget is much larger (not just budget exhaustion)', async () => {
    // 上のテストは既定 retries:2 (最大3試行) の枠を使い切ることでも 3 回で
    // 止まって見えてしまい、「timeout 由来のリトライは高々1回」という
    // timeoutRetryUsed フラグ自体の効果と区別できない (2回目のレビューで
    // 指摘)。ここでは retries:5 (最大6試行) という、フラグが無ければ
    // まだ何度でもリトライを続けられるはずの大きな予算を与えた上で、
    // timeout が連続しても2試行目以降はリトライされず即座に投げ直される
    // ことを直接確認する — 「予算切れ」ではなく「timeout 専用の上限」で
    // 止まっていることのピン止め。
    const error = new BdError('timeout', 'p', 'context canceled');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(noDelaySleep());

    await expect(
      withTransientReadRetry(operation, { retries: 5, sleep }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
