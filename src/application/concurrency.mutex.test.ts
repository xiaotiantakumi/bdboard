import { describe, expect, it } from 'vitest';
import { createMutex } from './concurrency.js';

// createMutex の契約: 呼び出しを 1 本ずつ直列に流す / 前が reject しても次は走る /
// 戻り値と reject は fn のものがそのまま呼び出し元に届く。
// 手動で解決できる Promise を使い、タイマーに頼らず順序だけを検証する。

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// マイクロタスクキューを空にして、待ち状態の呼び出しが先へ進める余地を作る。
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('createMutex', () => {
  it('runs calls one at a time in call order', async () => {
    const lock = createMutex();
    const events: string[] = [];
    const firstGate = deferred<void>();

    const first = lock(async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
    });
    const second = lock(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await flush();
    // 1 本目が終わるまで 2 本目は始まらない。
    expect(events).toEqual(['first:start']);

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('still runs the next call after the previous one rejected', async () => {
    const lock = createMutex();
    const failure = new Error('boom');

    const failed = lock(async () => {
      throw failure;
    });
    const next = lock(async () => 'ran');

    await expect(failed).rejects.toBe(failure);
    await expect(next).resolves.toBe('ran');
  });

  it('hands the resolved value and the rejection straight back to each caller', async () => {
    const lock = createMutex();
    const failure = new Error('only for the second caller');

    const value = lock(async () => ({ answer: 42 }));
    const failed = lock(async () => {
      throw failure;
    });
    const after = lock(async () => 'unaffected');

    await expect(value).resolves.toEqual({ answer: 42 });
    await expect(failed).rejects.toBe(failure);
    await expect(after).resolves.toBe('unaffected');
  });

  it('keeps separate mutexes independent of each other', async () => {
    const lockA = createMutex();
    const lockB = createMutex();
    const gate = deferred<void>();

    const blocked = lockA(async () => {
      await gate.promise;
      return 'a';
    });
    // lockA が塞がっていても lockB の呼び出しは待たされない。
    await expect(lockB(async () => 'b')).resolves.toBe('b');

    gate.resolve();
    await expect(blocked).resolves.toBe('a');
  });
});
