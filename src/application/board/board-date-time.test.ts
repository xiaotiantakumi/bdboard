import { describe, expect, it } from 'vitest';
import { addCalendarDaysToDateKey, localDateKey, zonedMidnight } from './board-date-time.js';

describe('zonedMidnight', () => {
  it('returns UTC midnight for UTC', () => {
    expect(zonedMidnight('2026-08-15', 'UTC').toISOString()).toBe(
      '2026-08-15T00:00:00.000Z',
    );
  });

  it('returns JST midnight for Asia/Tokyo', () => {
    expect(zonedMidnight('2026-08-15', 'Asia/Tokyo').toISOString()).toBe(
      '2026-08-14T15:00:00.000Z',
    );
  });

  it('returns local midnight on Pacific/Auckland DST spring-forward day', () => {
    const timeZone = 'Pacific/Auckland';
    const midnight = zonedMidnight('2026-09-27', timeZone);
    expect(midnight.toISOString()).toBe('2026-09-26T12:00:00.000Z');
    expect(localDateKey(midnight, timeZone)).toBe('2026-09-27');
  });
});

describe('addCalendarDaysToDateKey', () => {
  const newYork = 'America/New_York';

  it('advances one calendar day on a normal day', () => {
    expect(addCalendarDaysToDateKey('2026-08-15', 1, newYork)).toBe('2026-08-16');
  });

  it('advances across America/New_York DST fall-back day (25 local hours)', () => {
    expect(addCalendarDaysToDateKey('2026-11-01', 1, newYork)).toBe('2026-11-02');
    expect(addCalendarDaysToDateKey('2026-11-01', 5, newYork)).toBe('2026-11-06');
  });

  it('advances seven calendar days across a fall-back week', () => {
    expect(addCalendarDaysToDateKey('2026-10-26', 7, newYork)).toBe('2026-11-02');
  });

  it('advances across America/New_York DST spring-forward day (23 local hours)', () => {
    expect(addCalendarDaysToDateKey('2026-03-08', 1, newYork)).toBe('2026-03-09');
    expect(addCalendarDaysToDateKey('2026-03-02', 7, newYork)).toBe('2026-03-09');
  });
});
