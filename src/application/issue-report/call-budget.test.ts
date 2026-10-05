import { describe, expect, it } from 'vitest';
import { createSlidingWindowBudget } from './call-budget.js';

describe('sliding window budget', () => {
  it('limits use and expires the half-open window', () => {
    let now = 0;
    const budget = createSlidingWindowBudget({ limit: 2, windowMs: 100, now: () => now });
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.used()).toBe(2);
    now = 99;
    expect(budget.tryConsume()).toBe(false);
    now = 100;
    expect(budget.used()).toBe(0);
    expect(budget.tryConsume()).toBe(true);
  });

  it('preserves accepted history when the clock moves backwards', () => {
    let now = 100;
    const budget = createSlidingWindowBudget({ limit: 1, windowMs: 50, now: () => now });
    expect(budget.tryConsume()).toBe(true);
    now = 10;
    expect(budget.tryConsume()).toBe(false);
  });

  it('keeps every accepted 13th event at least one window from the first', () => {
    let now = 0;
    let seed = 0x12345678;
    const accepted: number[] = [];
    const budget = createSlidingWindowBudget({ limit: 12, windowMs: 3_600_000, now: () => now });
    for (let i = 0; i < 50_000; i += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      now += seed % 500;
      if (budget.tryConsume()) accepted.push(now);
    }
    for (let index = 0; index + 12 < accepted.length; index += 1) {
      expect(accepted[index + 12]! - accepted[index]!).toBeGreaterThanOrEqual(3_600_000);
    }
  });
});
