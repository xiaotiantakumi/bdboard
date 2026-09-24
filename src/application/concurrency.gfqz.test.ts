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
    const low0 = sem.acquire(() => 'low').then(() => order.push('low-0'));
    const low1 = sem.acquire(() => 'low').then(() => order.push('low-1'));
    const low2 = sem.acquire(() => 'low').then(() => order.push('low-2'));
    // 後から来た前景リクエスト。
    const high = sem.acquire(() => 'high').then(() => order.push('high'));

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

  it(
    're-evaluates priority at grant time: a waiter whose priority flips from high to ' +
      'low while still queued does not jump ahead of a still-genuinely-high waiter that ' +
      'queues later (this is the core bdboard-gfqz fix — priority must not be frozen at ' +
      'the moment acquire() is called)',
    async () => {
      const sem = new Semaphore(1);
      const order: string[] = [];
      await sem.acquire(); // 唯一の permit を握る

      // 「まだ応答を待っている前景リクエストのつもりで並んだが、待っている間に自分の
      // overallTimeoutMs が発火してバックグラウンド継続へ切り替わった」チケットを模す
      // (get-pr-badges.ts の `timedOut` と同じ片方向の状態遷移)。
      let firstStillForeground = true;
      const first = sem
        .acquire(() => (firstStillForeground ? 'high' : 'low'))
        .then(() => order.push('first'));

      // first が降格したあとに、本当にまだ応答を待っている別リクエストのチケットが並ぶ。
      firstStillForeground = false;
      const second = sem.acquire(() => 'high').then(() => order.push('second'));

      sem.release();
      await second;
      sem.release();
      await first;

      expect(order).toEqual(['second', 'first']);
    },
  );

  it(
    're-checks priority on every single release, not just the first time a waiter is ' +
      'considered (a waiter granted after several releases still reflects its CURRENT ' +
      'priority at the moment it is finally granted, not whatever it was when first queued ' +
      'or first inspected)',
    async () => {
      const sem = new Semaphore(1);
      const order: string[] = [];
      await sem.acquire(); // 唯一の permit を握る

      let bgTimedOut = false;
      const warm = sem.acquire(() => 'high').then(() => order.push('warm')); // 最初に permit を握る
      const bg = sem.acquire(() => (bgTimedOut ? 'low' : 'high')).then(() => order.push('bg'));

      sem.release(); // warm が permit を得る。この時点では bg はまだ 'high' のまま
      await warm;

      bgTimedOut = true; // bg がここで初めて 'low' に降格する
      const fg = sem.acquire(() => 'high').then(() => order.push('fg'));

      sem.release();
      await fg;
      sem.release();
      await bg;

      expect(order).toEqual(['warm', 'fg', 'bg']);
    },
  );

  it(
    'the starvation-guard counter does not accumulate during a stretch with no low waiter ' +
      'present, so a low waiter that arrives later is not granted prematurely (closes a ' +
      'mutation-testing gap: an "always increment on every high grant" variant would grant ' +
      'the low waiter here at the wrong moment)',
    async () => {
      const sem = new Semaphore(1);
      const order: string[] = [];
      await sem.acquire();

      // 5件の high を、low が1件も無い状態で連続して通す (ガードのカウンタは
      // 進まないはず —— 'low' 待ちが実在しない間は「足止めした」と数えない)。
      for (let i = 0; i < 5; i += 1) {
        const p = sem.acquire(() => 'high').then(() => order.push(`h${i}`));
        sem.release();
        await p;
      }

      // ここでようやく low と high を1件ずつ並べる。
      const h5 = sem.acquire(() => 'high').then(() => order.push('h5'));
      const low = sem.acquire(() => 'low').then(() => order.push('low'));
      const h6 = sem.acquire(() => 'high').then(() => order.push('h6'));

      sem.release();
      await h5;
      sem.release();
      await h6;
      sem.release();
      await low;

      // ガードが正しければ、low が来てから 'high' に4回連続で渡すまでは
      // low は通らない —— h5, h6 の2回しか無いので、low は最後に回る
      // (「常に加算」変種なら、この前の5回の高優先度連続許可が既にガードを
      // 発動させてしまい、もっと早く low が通ってしまう)。
      expect(order).toEqual(['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'low']);
    },
  );

  it('never grants more concurrent permits than the configured limit, regardless of priority mix', async () => {
    const limit = 2;
    const sem = new Semaphore(limit);
    let active = 0;
    let maxActive = 0;

    const worker = async (priority: 'high' | 'low') => {
      await sem.acquire(() => priority);
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
      sem.acquire(() => 'high').then(() => {
        if (!lowGranted) {
          highGrantsBeforeLow += 1;
        }
      }),
    );
    const low = sem.acquire(() => 'low').then(() => {
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

  it('grants low waiters at a fixed 4-high-to-1-low ratio while both queues stay backlogged (pins the exact starvation-guard ratio, closing a mutation-testing gap the opus review found in round 1)', async () => {
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const sem = new Semaphore(1);
    await sem.acquire(); // 唯一の permit を握る
    const order: string[] = [];

    // 10件の high と3件の low を最初から全部並べておく (優先度は固定値、動かない)。
    for (let i = 0; i < 10; i += 1) {
      void sem.acquire(() => 'high').then(() => order.push(`h${i}`));
    }
    for (let i = 0; i < 3; i += 1) {
      void sem.acquire(() => 'low').then(() => order.push(`l${i}`));
    }

    for (let i = 0; i < 13; i += 1) {
      sem.release();
      await flush();
    }

    expect(order).toEqual([
      'h0', 'h1', 'h2', 'h3', 'l0',
      'h4', 'h5', 'h6', 'h7', 'l1',
      'h8', 'h9', 'l2',
    ]);
  });

  it(
    'callers that never pass a priority (the pre-bdboard-gfqz calling convention — e.g. ' +
      'commentGate, which always calls acquire() with no argument at all) see byte-for-byte ' +
      'the same plain FIFO grant order and the same concurrency cap as before priority ' +
      'existed. This pins that adding priority support did not change the default ' +
      '(no-argument acquire()) behavior for callers that opt out of it (chair directive, ' +
      'bdboard-gfqz)',
    async () => {
      const limit = 2;
      const sem = new Semaphore(limit);
      let active = 0;
      let maxActive = 0;
      const grantOrder: number[] = [];
      const completionOrder: number[] = [];

      const worker = async (id: number) => {
        await sem.acquire(); // 優先度を一切渡さない — commentGate はこの形でしか呼ばない
        grantOrder.push(id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        completionOrder.push(id);
        sem.release();
      };

      // 5件を同じタイミングで起動する。limit=2 なので同時 active は高々2件のはずで、
      // permit を得る順序は起動順 (到着順) とそのまま一致するはず — 優先度が
      // 一切絡まない素の FIFO であることを確認する。
      await Promise.all([0, 1, 2, 3, 4].map((id) => worker(id)));

      expect(maxActive).toBeLessThanOrEqual(limit);
      expect(maxActive).toBe(limit);
      expect(grantOrder).toEqual([0, 1, 2, 3, 4]);
      expect(completionOrder).toEqual([0, 1, 2, 3, 4]);
    },
  );
});
