import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addCalendarDaysToDateKey,
  localDateKey,
  subtractCalendarDaysFromDateKey,
  zonedMidnight,
} from './board-date-time.js';

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

  it('returns the first local instant of the day on America/Santiago DST spring-forward-at-midnight day', () => {
    const timeZone = 'America/Santiago';
    const midnight = zonedMidnight('2025-09-07', timeZone);
    expect(midnight.toISOString()).toBe('2025-09-07T04:00:00.000Z');
    expect(localDateKey(midnight, timeZone)).toBe('2025-09-07');
  });

  it('returns the first local instant of the day on America/Asuncion DST spring-forward-at-midnight day', () => {
    const timeZone = 'America/Asuncion';
    const midnight = zonedMidnight('2025-10-05', timeZone);
    expect(midnight.toISOString()).toBe('2025-10-05T04:00:00.000Z');
    expect(localDateKey(midnight, timeZone)).toBe('2025-10-05');
  });

  it('returns the first local instant of the day on America/Havana DST spring-forward-at-midnight day', () => {
    const timeZone = 'America/Havana';
    const midnight = zonedMidnight('2026-03-08', timeZone);
    expect(midnight.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(localDateKey(midnight, timeZone)).toBe('2026-03-08');
  });

  it('still returns local midnight unchanged on America/New_York DST spring-forward day (transition is at 02:00, not skipped)', () => {
    const timeZone = 'America/New_York';
    const midnight = zonedMidnight('2026-03-08', timeZone);
    expect(localDateKey(midnight, timeZone)).toBe('2026-03-08');
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

  it('steps across an America/Santiago DST midnight-skip day correctly (bdboard-ybcv)', () => {
    const santiago = 'America/Santiago';
    expect(subtractCalendarDaysFromDateKey('2025-09-07', 1, santiago)).toBe('2025-09-06');
    expect(addCalendarDaysToDateKey('2025-09-06', 1, santiago)).toBe('2025-09-07');
  });
});

describe('zonedMidnight / localDateKey round-trip on DST midnight-skip days (bdboard-ybcv)', () => {
  // All (dateKey, timeZone) pairs where local midnight is skipped by a DST
  // transition, 2015-2030, across every IANA time zone (brute-force
  // verified once; see PR description for the verification script/method).
  const skippedMidnightDays: ReadonlyArray<readonly [string, string]> = [
    ['2015-10-04', 'America/Asuncion'],
    ['2016-10-02', 'America/Asuncion'],
    ['2017-10-01', 'America/Asuncion'],
    ['2018-10-07', 'America/Asuncion'],
    ['2019-10-06', 'America/Asuncion'],
    ['2020-10-04', 'America/Asuncion'],
    ['2021-10-03', 'America/Asuncion'],
    ['2022-10-02', 'America/Asuncion'],
    ['2023-10-01', 'America/Asuncion'],
    ['2024-10-06', 'America/Asuncion'],
    ['2025-10-05', 'America/Asuncion'],
    ['2026-10-04', 'America/Asuncion'],
    ['2027-10-03', 'America/Asuncion'],
    ['2028-10-01', 'America/Asuncion'],
    ['2029-10-07', 'America/Asuncion'],
    ['2030-10-06', 'America/Asuncion'],
    ['2015-10-18', 'America/Campo_Grande'],
    ['2016-10-16', 'America/Campo_Grande'],
    ['2017-10-15', 'America/Campo_Grande'],
    ['2018-11-04', 'America/Campo_Grande'],
    ['2015-10-18', 'America/Cuiaba'],
    ['2016-10-16', 'America/Cuiaba'],
    ['2017-10-15', 'America/Cuiaba'],
    ['2018-11-04', 'America/Cuiaba'],
    ['2015-03-08', 'America/Havana'],
    ['2016-03-13', 'America/Havana'],
    ['2017-03-12', 'America/Havana'],
    ['2018-03-11', 'America/Havana'],
    ['2019-03-10', 'America/Havana'],
    ['2020-03-08', 'America/Havana'],
    ['2021-03-14', 'America/Havana'],
    ['2022-03-13', 'America/Havana'],
    ['2023-03-12', 'America/Havana'],
    ['2024-03-10', 'America/Havana'],
    ['2025-03-09', 'America/Havana'],
    ['2026-03-08', 'America/Havana'],
    ['2027-03-14', 'America/Havana'],
    ['2028-03-12', 'America/Havana'],
    ['2029-03-11', 'America/Havana'],
    ['2030-03-10', 'America/Havana'],
    ['2016-08-14', 'America/Punta_Arenas'],
    ['2016-08-14', 'America/Santiago'],
    ['2017-08-13', 'America/Santiago'],
    ['2018-08-12', 'America/Santiago'],
    ['2019-09-08', 'America/Santiago'],
    ['2020-09-06', 'America/Santiago'],
    ['2021-09-05', 'America/Santiago'],
    ['2022-09-11', 'America/Santiago'],
    ['2023-09-03', 'America/Santiago'],
    ['2024-09-08', 'America/Santiago'],
    ['2025-09-07', 'America/Santiago'],
    ['2026-09-06', 'America/Santiago'],
    ['2027-09-05', 'America/Santiago'],
    ['2028-09-03', 'America/Santiago'],
    ['2029-09-02', 'America/Santiago'],
    ['2030-09-08', 'America/Santiago'],
    ['2015-10-18', 'America/Sao_Paulo'],
    ['2016-10-16', 'America/Sao_Paulo'],
    ['2017-10-15', 'America/Sao_Paulo'],
    ['2018-11-04', 'America/Sao_Paulo'],
    ['2015-03-29', 'America/Scoresbysund'],
    ['2016-03-27', 'America/Scoresbysund'],
    ['2017-03-26', 'America/Scoresbysund'],
    ['2018-03-25', 'America/Scoresbysund'],
    ['2019-03-31', 'America/Scoresbysund'],
    ['2020-03-29', 'America/Scoresbysund'],
    ['2021-03-28', 'America/Scoresbysund'],
    ['2022-03-27', 'America/Scoresbysund'],
    ['2023-03-26', 'America/Scoresbysund'],
    ['2016-08-14', 'Antarctica/Palmer'],
    ['2015-03-29', 'Atlantic/Azores'],
    ['2016-03-27', 'Atlantic/Azores'],
    ['2017-03-26', 'Atlantic/Azores'],
    ['2018-03-25', 'Atlantic/Azores'],
    ['2019-03-31', 'Atlantic/Azores'],
    ['2020-03-29', 'Atlantic/Azores'],
    ['2021-03-28', 'Atlantic/Azores'],
    ['2022-03-27', 'Atlantic/Azores'],
    ['2023-03-26', 'Atlantic/Azores'],
    ['2024-03-31', 'Atlantic/Azores'],
    ['2025-03-30', 'Atlantic/Azores'],
    ['2026-03-29', 'Atlantic/Azores'],
    ['2027-03-28', 'Atlantic/Azores'],
    ['2028-03-26', 'Atlantic/Azores'],
    ['2029-03-25', 'Atlantic/Azores'],
    ['2030-03-31', 'Atlantic/Azores'],
  ];

  it('has exactly 86 known skipped-midnight days (regression guard for the fixture list itself)', () => {
    expect(skippedMidnightDays.length).toBe(86);
  });

  it.each(skippedMidnightDays)(
    'round-trips %s in %s even though local midnight is skipped',
    (dateKey, timeZone) => {
      const midnight = zonedMidnight(dateKey, timeZone);
      expect(localDateKey(midnight, timeZone)).toBe(dateKey);
    },
  );
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
