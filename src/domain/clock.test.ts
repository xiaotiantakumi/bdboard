import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock.js';

describe('fixedClock', () => {
  const at = new Date('2026-01-01T00:00:00.000Z');

  it('returns the same time on every call', () => {
    const clock = fixedClock(at);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns a new Date instance each time', () => {
    const clock = fixedClock(at);
    const first = clock.now();
    const second = clock.now();
    expect(first).not.toBe(second);
    expect(first.getTime()).toBe(second.getTime());
  });

  it('is not affected when the returned Date is mutated', () => {
    const clock = fixedClock(at);
    const returned = clock.now();
    returned.setFullYear(2099);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is not affected when the source Date is mutated after creation', () => {
    const source = new Date('2026-01-01T00:00:00.000Z');
    const clock = fixedClock(source);
    source.setFullYear(2099);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
