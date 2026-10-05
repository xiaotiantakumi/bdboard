import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SELF_ERROR_THROTTLE_INTERVAL_MS,
  DEFAULT_SELF_ERROR_THROTTLE_MAX_KEYS,
  createSelfErrorThrottle,
} from './self-error-throttle.js';

const BASE = new Date('2026-10-05T00:00:00.000Z').getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (offsetMs: number): Date => new Date(BASE + offsetMs);

describe('createSelfErrorThrottle', () => {
  it('has defaults of one report per hour and 500 keys', () => {
    expect(DEFAULT_SELF_ERROR_THROTTLE_INTERVAL_MS).toBe(HOUR);
    expect(DEFAULT_SELF_ERROR_THROTTLE_MAX_KEYS).toBe(500);
  });

  it('reports a new key, then stays quiet however often it is asked within the hour', () => {
    const throttle = createSelfErrorThrottle();
    expect(throttle.shouldReport('k', at(0))).toBe(true);
    for (let second = 1; second <= 10; second += 1) {
      expect(throttle.shouldReport('k', at(second * 1000))).toBe(false);
    }
  });

  it('reports again exactly one hour after the last report, not one millisecond before', () => {
    const throttle = createSelfErrorThrottle();
    expect(throttle.shouldReport('k', at(0))).toBe(true);
    expect(throttle.shouldReport('k', at(HOUR - 1))).toBe(false);
    expect(throttle.shouldReport('k', at(HOUR))).toBe(true);
  });

  it('does not push the next report back when it suppresses (0:00 true, 0:30 false, 1:00 true)', () => {
    const throttle = createSelfErrorThrottle();
    expect(throttle.shouldReport('k', at(0))).toBe(true);
    expect(throttle.shouldReport('k', at(30 * MINUTE))).toBe(false);
    expect(throttle.shouldReport('k', at(HOUR))).toBe(true);
    expect(throttle.shouldReport('k', at(HOUR + 30 * MINUTE))).toBe(false);
    expect(throttle.shouldReport('k', at(2 * HOUR))).toBe(true);
  });

  it('keeps keys independent of each other', () => {
    const throttle = createSelfErrorThrottle();
    expect(throttle.shouldReport('a', at(0))).toBe(true);
    expect(throttle.shouldReport('b', at(1))).toBe(true);
    expect(throttle.shouldReport('a', at(2))).toBe(false);
    expect(throttle.shouldReport('b', at(3))).toBe(false);
  });

  it('forgets the oldest key once 500 keys are exceeded, so that key reports again', () => {
    const throttle = createSelfErrorThrottle();
    for (let index = 0; index < 500; index += 1) {
      expect(throttle.shouldReport(`key-${index}`, at(index))).toBe(true);
    }
    expect(throttle.size()).toBe(500);
    expect(throttle.shouldReport('key-500', at(500))).toBe(true);
    expect(throttle.size()).toBe(500);
    // key-0 は忘れられたので、時間がたっていなくても「初めて」になる。key-1 はまだ覚えている。
    expect(throttle.shouldReport('key-1', at(501))).toBe(false);
    expect(throttle.shouldReport('key-0', at(502))).toBe(true);
  });

  it('evicts by least recent use: a key asked about (even when suppressed) outlives an older untouched one', () => {
    const throttle = createSelfErrorThrottle({ maxKeys: 3 });
    throttle.shouldReport('a', at(0));
    throttle.shouldReport('b', at(1));
    throttle.shouldReport('c', at(2));
    expect(throttle.shouldReport('a', at(3))).toBe(false);
    throttle.shouldReport('d', at(4));
    expect(throttle.size()).toBe(3);
    // b が最も使われていなかったので消え、a は残る。
    expect(throttle.shouldReport('a', at(5))).toBe(false);
    expect(throttle.shouldReport('b', at(6))).toBe(true);
  });

  it('honours intervalMs and maxKeys options', () => {
    const throttle = createSelfErrorThrottle({ intervalMs: 10, maxKeys: 2 });
    expect(throttle.shouldReport('a', at(0))).toBe(true);
    expect(throttle.shouldReport('a', at(9))).toBe(false);
    expect(throttle.shouldReport('a', at(10))).toBe(true);
    throttle.shouldReport('b', at(11));
    throttle.shouldReport('c', at(12));
    expect(throttle.size()).toBe(2);
  });

  it('reports every time when intervalMs is 0', () => {
    const throttle = createSelfErrorThrottle({ intervalMs: 0 });
    expect(throttle.shouldReport('k', at(0))).toBe(true);
    expect(throttle.shouldReport('k', at(0))).toBe(true);
  });

  it('falls back to the defaults for unusable options', () => {
    const throttle = createSelfErrorThrottle({ intervalMs: Number.NaN, maxKeys: Number.NaN });
    expect(throttle.shouldReport('k', at(0))).toBe(true);
    expect(throttle.shouldReport('k', at(HOUR - 1))).toBe(false);
    expect(throttle.shouldReport('k', at(HOUR))).toBe(true);
    const negative = createSelfErrorThrottle({ intervalMs: -5, maxKeys: 0.5 });
    expect(negative.shouldReport('k', at(0))).toBe(true);
    expect(negative.shouldReport('k', at(HOUR - 1))).toBe(false);
    expect(negative.shouldReport('other', at(1))).toBe(true);
    expect(negative.size()).toBe(2);
    const infinite = createSelfErrorThrottle({ intervalMs: Number.POSITIVE_INFINITY });
    infinite.shouldReport('k', at(0));
    expect(infinite.shouldReport('k', at(HOUR))).toBe(true);
  });

  it('lets a forgotten key report again before the hour is up', () => {
    const throttle = createSelfErrorThrottle();
    throttle.shouldReport('k', at(0));
    throttle.forget('k');
    expect(throttle.size()).toBe(0);
    expect(throttle.shouldReport('k', at(1))).toBe(true);
  });

  it('ignores forgetting a key it does not know', () => {
    const throttle = createSelfErrorThrottle();
    throttle.shouldReport('k', at(0));
    throttle.forget('missing');
    expect(throttle.size()).toBe(1);
    expect(throttle.shouldReport('k', at(1))).toBe(false);
  });

  it('resumes within one interval when the clock goes backwards', () => {
    const throttle = createSelfErrorThrottle();
    expect(throttle.shouldReport('k', at(HOUR))).toBe(true);
    expect(throttle.shouldReport('k', at(0))).toBe(false);
    expect(throttle.shouldReport('k', at(HOUR - 1))).toBe(false);
    expect(throttle.shouldReport('k', at(HOUR))).toBe(true);
  });

  it('returns false for an invalid date and changes no state', () => {
    const throttle = createSelfErrorThrottle();
    expect(throttle.shouldReport('new', new Date(Number.NaN))).toBe(false);
    expect(throttle.size()).toBe(0);
    expect(throttle.shouldReport('new', at(0))).toBe(true);
    expect(throttle.shouldReport('new', new Date(Number.NaN))).toBe(false);
    expect(throttle.shouldReport('new', at(HOUR))).toBe(true);
  });

  it('shares no state between instances', () => {
    expect(createSelfErrorThrottle().shouldReport('k', at(0))).toBe(true);
    expect(createSelfErrorThrottle().shouldReport('k', at(0))).toBe(true);
  });
});
