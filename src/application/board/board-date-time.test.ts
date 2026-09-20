import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('Intl.DateTimeFormat construction count (bdboard-k99x)', () => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;

  afterEach(() => {
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  });

  it('constructs a bounded number of formatters across many calls for one timeZone', async () => {
    // Fresh module graph so the cache this test observes isn't pre-populated
    // by the describe blocks above (which already exercised these helpers).
    vi.resetModules();
    const boardDateTime = await import('./board-date-time.js');

    let constructCount = 0;
    class CountingDateTimeFormat extends OriginalDateTimeFormat {
      constructor(locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
        super(locale, options);
        constructCount += 1;
      }
    }
    Intl.DateTimeFormat = CountingDateTimeFormat as unknown as typeof Intl.DateTimeFormat;

    const timeZone = 'Asia/Tokyo';
    let dateKey = '2026-01-01';
    for (let index = 0; index < 200; index += 1) {
      const now = boardDateTime.zonedMidnight(dateKey, timeZone);
      boardDateTime.localDateKey(now, timeZone);
      boardDateTime.getWeekdayInTimeZone(now, timeZone);
      dateKey = boardDateTime.addCalendarDaysToDateKey(dateKey, 1, timeZone);
    }

    // board-date-time.ts uses exactly 3 distinct (locale, options) shapes
    // (date-key, offset, weekday) for a single timeZone, regardless of how
    // many dates/iterations are exercised — this is the regression guard for
    // the O(calls) formatter construction bdboard-k99x fixed. The lower bound
    // guards against the instrumentation itself silently doing nothing (e.g.
    // if resetModules/the class swap stopped taking effect, this would still
    // pass at 0 without it).
    expect(constructCount).toBeGreaterThan(0);
    expect(constructCount).toBeLessThanOrEqual(3);
  });
});
