import { describe, expect, it } from 'vitest';
import { daysUntilDefer, deriveDeferUrgency } from './defer.js';

// Dates are built with the local constructor rather than from UTC strings, because
// the day boundary is deliberately local: a UTC literal would mean a different
// calendar day depending on the machine running the suite, so these cases would
// pass in one timezone and fail in another.
function localDate(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  return new Date(year, monthIndex, day, hour, minute);
}

describe('daysUntilDefer', () => {
  it('returns null when deferUntil is invalid', () => {
    expect(daysUntilDefer(new Date('invalid'), localDate(2026, 5, 1, 12))).toBeNull();
  });

  it('returns null when now is invalid', () => {
    expect(
      daysUntilDefer(localDate(2026, 5, 5, 23, 59), new Date('invalid')),
    ).toBeNull();
  });

  it('returns negative days when deferUntil is on an earlier calendar day', () => {
    expect(
      daysUntilDefer(localDate(2026, 5, 3, 23, 59), localDate(2026, 5, 5, 12)),
    ).toBe(-2);
  });

  it('returns 0 for the same calendar day even when deferUntil is late in it', () => {
    expect(
      daysUntilDefer(localDate(2026, 5, 5, 23, 59), localDate(2026, 5, 5, 8)),
    ).toBe(0);
  });

  it('counts calendar days, not elapsed hours', () => {
    // Barely over one hour apart, but on either side of midnight: one day, not zero.
    expect(
      daysUntilDefer(localDate(2026, 5, 6, 0, 30), localDate(2026, 5, 5, 23, 30)),
    ).toBe(1);
  });

  it('returns 3 for three calendar days ahead', () => {
    expect(
      daysUntilDefer(localDate(2026, 5, 4, 0, 1), localDate(2026, 5, 1, 12)),
    ).toBe(3);
  });

  it('returns 4 for four calendar days ahead', () => {
    expect(
      daysUntilDefer(localDate(2026, 5, 5), localDate(2026, 5, 1, 12)),
    ).toBe(4);
  });

  it('uses an explicit IANA timezone when timeZone is provided', () => {
    const deferUntil = new Date('2026-06-08T00:00:00.000Z');
    const now = new Date('2026-06-01T15:00:00.000Z');

    // UTC: June 1 vs June 8 → 7 days
    expect(daysUntilDefer(deferUntil, now, 'UTC')).toBe(7);
    // Asia/Tokyo: June 2 00:00 vs June 8 09:00 → 6 days
    expect(daysUntilDefer(deferUntil, now, 'Asia/Tokyo')).toBe(6);
  });
});

describe('deriveDeferUrgency', () => {
  const now = localDate(2026, 5, 5, 12);

  it('returns null when daysUntilDefer would be null', () => {
    expect(deriveDeferUrgency(new Date('invalid'), now)).toBeNull();
  });

  it('classifies overdue, today, soon, and later boundaries', () => {
    expect(deriveDeferUrgency(localDate(2026, 5, 3, 12), now)).toBe('overdue');
    expect(deriveDeferUrgency(localDate(2026, 5, 5, 23, 59), now)).toBe('today');
    expect(deriveDeferUrgency(localDate(2026, 5, 8), now)).toBe('soon');
    expect(deriveDeferUrgency(localDate(2026, 5, 9), now)).toBe('later');
  });

  it('respects an explicit IANA timezone', () => {
    const deferUntil = new Date('2026-06-05T00:00:00.000Z');
    const boundaryNow = new Date('2026-06-01T15:00:00.000Z');

    expect(deriveDeferUrgency(deferUntil, boundaryNow, 'UTC')).toBe('later');
    expect(deriveDeferUrgency(deferUntil, boundaryNow, 'Asia/Tokyo')).toBe('soon');
  });
});
