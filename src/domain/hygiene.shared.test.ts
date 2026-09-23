import { describe, expect, it } from 'vitest';
import { formatLocalDateKey } from './hygiene.js';
import { localDate } from './hygiene-test-support.js';

describe('formatLocalDateKey', () => {
  it('formats a locally constructed date as YYYY-MM-DD', () => {
    expect(formatLocalDateKey(localDate(2026, 8, 10))).toBe('2026-08-10');
    expect(formatLocalDateKey(localDate(2026, 1, 5))).toBe('2026-01-05');
  });

  it('uses local timezone rather than UTC when the instant crosses a calendar day', () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      // `bd defer --until=2026-08-10` in JST is stored as 2026-08-09T15:00:00Z.
      expect(formatLocalDateKey(new Date('2026-08-09T15:00:00Z'))).toBe(
        '2026-08-10',
      );
    } finally {
      if (previousTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTz;
      }
    }
  });

  it('formats using the specified IANA timezone regardless of host TZ', () => {
    const instant = new Date('2026-08-09T15:00:00Z');
    expect(formatLocalDateKey(instant, 'UTC')).toBe('2026-08-09');
    expect(formatLocalDateKey(instant, 'Asia/Tokyo')).toBe('2026-08-10');
  });
});
