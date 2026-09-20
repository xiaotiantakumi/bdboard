import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCachedDateTimeFormat } from './intl-format-cache.js';

// The three option shapes actually used by board-date-time.ts / defer.ts /
// hygiene/shared.ts (bdboard-k99x). Kept here (rather than imported) so this
// test doesn't silently stop covering a shape if a call site changes it.
const DATE_KEY_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
};

const OFFSET_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
};

const WEEKDAY_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: 'short',
};

const TIME_ZONES = ['UTC', 'Asia/Tokyo', 'America/New_York'] as const;

/** Hourly instants spanning a few days around each zone's DST edges, plus a
 * plain mid-year stretch, so equivalence is checked across ordinary days and
 * both DST transition directions. */
function sampleInstants(): readonly Date[] {
  const instants: Date[] = [];
  const starts = [
    Date.UTC(2026, 0, 1), // plain UTC stretch
    Date.UTC(2026, 2, 6), // around America/New_York spring-forward (2026-03-08)
    Date.UTC(2026, 9, 30), // around America/New_York fall-back (2026-11-01)
    Date.UTC(2026, 5, 15), // plain mid-year stretch
  ];
  for (const start of starts) {
    for (let hourOffset = 0; hourOffset < 24 * 4; hourOffset += 1) {
      instants.push(new Date(start + hourOffset * 60 * 60 * 1000));
    }
  }
  return instants;
}

describe('getCachedDateTimeFormat', () => {
  it('returns the same instance for repeated calls with an equivalent (locale, options)', () => {
    const first = getCachedDateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // A fresh object literal with the same entries in a different key order —
    // proves the cache keys on option *content*, not the options object's
    // identity or its key insertion order.
    const second = getCachedDateTimeFormat('en-CA', {
      day: '2-digit',
      timeZone: 'Asia/Tokyo',
      month: '2-digit',
      year: 'numeric',
    });
    expect(second).toBe(first);
  });

  it('returns different instances for different timeZones', () => {
    const tokyo = getCachedDateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' });
    const utc = getCachedDateTimeFormat('en-CA', { timeZone: 'UTC' });
    expect(tokyo).not.toBe(utc);
  });

  it('returns different instances for different locales with the same options', () => {
    const enCa = getCachedDateTimeFormat('en-CA', { timeZone: 'UTC' });
    const jaJp = getCachedDateTimeFormat('ja-JP', { timeZone: 'UTC' });
    expect(enCa).not.toBe(jaJp);
  });

  describe.each(TIME_ZONES)('matches a naive (always-construct) implementation for %s', (timeZone) => {
    const instants = sampleInstants();

    it.each([
      ['date-key options', DATE_KEY_OPTIONS],
      ['offset options', OFFSET_OPTIONS],
      ['weekday options', WEEKDAY_OPTIONS],
    ] as const)('%s — format()', (_label, options) => {
      const merged: Intl.DateTimeFormatOptions = { ...options, timeZone };
      const cached = getCachedDateTimeFormat('en-CA', merged);
      const naive = new Intl.DateTimeFormat('en-CA', merged);
      for (const instant of instants) {
        expect(cached.format(instant)).toBe(naive.format(instant));
      }
    });

    it.each([
      ['date-key options', DATE_KEY_OPTIONS],
      ['offset options', OFFSET_OPTIONS],
      ['weekday options', WEEKDAY_OPTIONS],
    ] as const)('%s — formatToParts()', (_label, options) => {
      const merged: Intl.DateTimeFormatOptions = { ...options, timeZone };
      const cached = getCachedDateTimeFormat('en-US', merged);
      const naive = new Intl.DateTimeFormat('en-US', merged);
      for (const instant of instants) {
        expect(cached.formatToParts(instant)).toEqual(naive.formatToParts(instant));
      }
    });
  });
});

describe('Intl.DateTimeFormat construction count', () => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;

  afterEach(() => {
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  });

  it('constructs at most a small constant number of formatters for 1000 calls with the same timeZone', async () => {
    // Fresh module instance so this test's count isn't polluted by the cache
    // entries the equivalence tests above already populated.
    vi.resetModules();
    const { getCachedDateTimeFormat: freshGetCachedDateTimeFormat } = await import(
      './intl-format-cache.js'
    );

    let constructCount = 0;
    class CountingDateTimeFormat extends OriginalDateTimeFormat {
      constructor(locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
        super(locale, options);
        constructCount += 1;
      }
    }
    Intl.DateTimeFormat = CountingDateTimeFormat as unknown as typeof Intl.DateTimeFormat;

    for (let index = 0; index < 1000; index += 1) {
      // A fresh options object literal every call, matching real call sites
      // (board-date-time.ts builds a new object literal per invocation).
      freshGetCachedDateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    }

    // Exactly 1 expected (first call misses, the other 999 hit); a small
    // constant bound keeps this from being a brittle exact-equality check.
    expect(constructCount).toBeLessThanOrEqual(2);
    expect(constructCount).toBeGreaterThan(0);
  });
});
