import { describe, expect, it } from 'vitest';
import { createSlidingWindowBudget } from './call-budget.js';

const HOUR_MS = 3_600_000;

function createClock(startMs = 0) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    set(ms: number) {
      nowMs = ms;
    },
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe('createSlidingWindowBudget', () => {
  it('lets the limit through and refuses the next one without using it', () => {
    const clock = createClock();
    const budget = createSlidingWindowBudget({ limit: 3, windowMs: 1000, now: clock.now });

    expect([budget.tryConsume(), budget.tryConsume(), budget.tryConsume()]).toEqual([true, true, true]);
    expect(budget.used()).toBe(3);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.tryConsume()).toBe(false);
    // 断った分は数えない (数えると、断り続けるだけで窓が空かなくなる)。
    expect(budget.used()).toBe(3);
  });

  it('frees a slot exactly windowMs after it was used, not one ms earlier', () => {
    const clock = createClock(1000);
    const budget = createSlidingWindowBudget({ limit: 1, windowMs: 500, now: clock.now });
    expect(budget.tryConsume()).toBe(true);

    clock.set(1499);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.used()).toBe(1);

    clock.set(1500);
    expect(budget.used()).toBe(0);
    expect(budget.tryConsume()).toBe(true);
  });

  it('slides: a slot used later frees later, so a burst does not reset the whole window at once', () => {
    const clock = createClock();
    const budget = createSlidingWindowBudget({ limit: 2, windowMs: 1000, now: clock.now });
    expect(budget.tryConsume()).toBe(true); // t=0
    clock.set(600);
    expect(budget.tryConsume()).toBe(true); // t=600

    clock.set(1000); // t=0 の分だけ空く
    expect(budget.used()).toBe(1);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);

    clock.set(1600); // t=600 の分が空く。t=1000 の分は残る
    expect(budget.used()).toBe(1);
  });

  it('does not give anything back when the clock goes backwards', () => {
    const clock = createClock(10_000);
    const budget = createSlidingWindowBudget({ limit: 2, windowMs: 1000, now: clock.now });
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);

    clock.set(5000);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.used()).toBe(2);
    clock.set(0);
    expect(budget.tryConsume()).toBe(false);
  });

  it('keeps two budgets independent', () => {
    const clock = createClock();
    const first = createSlidingWindowBudget({ limit: 1, windowMs: 1000, now: clock.now });
    const second = createSlidingWindowBudget({ limit: 1, windowMs: 1000, now: clock.now });
    expect(first.tryConsume()).toBe(true);
    expect(first.tryConsume()).toBe(false);
    expect(second.tryConsume()).toBe(true);
  });

  it.each([
    ['a zero limit', { limit: 0, windowMs: 1000 }],
    ['a negative limit', { limit: -1, windowMs: 1000 }],
    ['a fractional limit', { limit: 1.5, windowMs: 1000 }],
    ['a NaN limit', { limit: Number.NaN, windowMs: 1000 }],
    ['a zero window', { limit: 1, windowMs: 0 }],
    ['a negative window', { limit: 1, windowMs: -5 }],
    ['an infinite window', { limit: 1, windowMs: Number.POSITIVE_INFINITY }],
    ['a NaN window', { limit: 1, windowMs: Number.NaN }],
  ])('refuses to be created with %s', (_label, options) => {
    expect(() => createSlidingWindowBudget({ ...options, now: () => 0 })).toThrow(RangeError);
  });
});

describe('createSlidingWindowBudget: no window of one hour holds more than the limit', () => {
  /** 受け付けた時刻の列から、長さ windowMs の窓 [start, start + windowMs) に入る最大の数を数える (窓の左端を受け付けた時刻に合わせれば足りる)。 */
  function maxInAnyWindow(acceptedAt: readonly number[], windowMs: number): number {
    let best = 0;
    let left = 0;
    for (let right = 0; right < acceptedAt.length; right += 1) {
      while (acceptedAt[right] - acceptedAt[left] >= windowMs) left += 1;
      best = Math.max(best, right - left + 1);
    }
    return best;
  }

  /** 種を固定した小さな乱数 (テストが毎回同じ列を試すため)。 */
  function createRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return state / 4_294_967_296;
    };
  }

  it.each([1, 2, 3, 12345, 20261006])('holds for a hostile random schedule (seed %i): bursts, silences and gaps near the window edge', (seed) => {
    const random = createRandom(seed);
    const clock = createClock();
    const budget = createSlidingWindowBudget({ limit: 12, windowMs: HOUR_MS, now: clock.now });
    const acceptedAt: number[] = [];

    for (let step = 0; step < 50_000; step += 1) {
      // 0 ms (同じ時刻の連打)、数秒、数分、ちょうど 1 時間前後の間隔を混ぜる。
      const pick = random();
      if (pick < 0.3) clock.advance(0);
      else if (pick < 0.6) clock.advance(Math.floor(random() * 10_000));
      else if (pick < 0.9) clock.advance(Math.floor(random() * 600_000));
      else clock.advance(HOUR_MS - 2 + Math.floor(random() * 5));
      if (budget.tryConsume()) acceptedAt.push(clock.now());
    }

    expect(acceptedAt.length).toBeGreaterThan(1000);
    expect(maxInAnyWindow(acceptedAt, HOUR_MS)).toBeLessThanOrEqual(12);
    // 窓が実際に埋まるところまで使われている (上限が緩すぎて通っているのではない)。
    expect(maxInAnyWindow(acceptedAt, HOUR_MS)).toBe(12);
  });

  it('refuses the 13th call in the same hour and accepts the first of the next hour', () => {
    const clock = createClock();
    const budget = createSlidingWindowBudget({ limit: 12, windowMs: HOUR_MS, now: clock.now });
    const accepted: boolean[] = [];
    for (let call = 0; call < 14; call += 1) {
      accepted.push(budget.tryConsume());
      clock.advance(60_000);
    }
    expect(accepted.filter(Boolean)).toHaveLength(12);
    expect(accepted.slice(12)).toEqual([false, false]);

    clock.set(HOUR_MS);
    expect(budget.tryConsume()).toBe(true);
  });
});
