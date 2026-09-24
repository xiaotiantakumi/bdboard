import { describe, expect, it } from 'vitest';
import { Semaphore } from './concurrency.js';

// bdboard-gfqz: statusGate (Semaphore) に足した2段優先度のスケジューリング契約を
// 直接検証する。getPrBadges()/resolvePrStatus() までの配線は
// board/resolve-pr-status.gfqz.test.ts と board/get-pr-badges.gfqz.test.ts を参照。

describe('Semaphore priority (bdboard-gfqz)', () => {
  it('lets a later high-priority acquire jump ahead of an already-queued low-priority backlog', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];

    await sem.acquire(); // 唯一の permit を握って、これ以降の acquire を待ち行列に積ませる

    // 先に low を3件並べる (バックグラウンド継続が大量に積まれている状態を模す)。
    const low0 = sem.acquire('low').then(() => order.push('low-0'));
    const low1 = sem.acquire('low').then(() => order.push('low-1'));
    const low2 = sem.acquire('low').then(() => order.push('low-2'));
    // 後から来た前景リクエスト。
    const high = sem.acquire('high').then(() => order.push('high'));

    sem.release();
    await high;
    sem.release();
    await low0;
    sem.release();
    await low1;
    sem.release();
    await low2;

    expect(order).toEqual(['high', 'low-0', 'low-1', 'low-2']);
  });

  it('never grants more concurrent permits than the configured limit, regardless of priority mix', async () => {
    const limit = 2;
    const sem = new Semaphore(limit);
    let active = 0;
    let maxActive = 0;

    const worker = async (priority: 'high' | 'low') => {
      await sem.acquire(priority);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      sem.release();
    };

    await Promise.all([
      worker('high'),
      worker('low'),
      worker('high'),
      worker('low'),
      worker('low'),
    ]);

    expect(maxActive).toBeLessThanOrEqual(limit);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('eventually grants a low-priority waiter even when many high-priority waiters are queued ahead of it (starvation guard)', async () => {
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const sem = new Semaphore(1);
    await sem.acquire(); // 唯一の permit を握って、これ以降の acquire を待ち行列に積ませる

    const highCount = 20;
    let lowGranted = false;
    let highGrantsBeforeLow = 0;

    const highs = Array.from({ length: highCount }, () =>
      sem.acquire('high').then(() => {
        if (!lowGranted) {
          highGrantsBeforeLow += 1;
        }
      }),
    );
    const low = sem.acquire('low').then(() => {
      lowGranted = true;
    });

    let completedHighs = 0;
    const trackedHighs = highs.map((promise) =>
      promise.then(() => {
        completedHighs += 1;
      }),
    );

    while (!lowGranted) {
      sem.release();
      await flush();
    }

    expect(lowGranted).toBe(true);
    // 20件の high 待ちが先に並んでいても、全部通ってからではなく途中で low が通る
    // (優先度が効いている証拠)。
    expect(highGrantsBeforeLow).toBeGreaterThan(0);
    expect(highGrantsBeforeLow).toBeLessThan(highCount);

    while (completedHighs < highCount) {
      sem.release();
      await flush();
    }
    // low の permit も返して手動制御を完了する。
    sem.release();
    await Promise.all([...trackedHighs, low]);
  });
});
