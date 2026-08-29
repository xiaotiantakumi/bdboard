import { describe, expect, it } from 'vitest';
import { localDateKey, zonedMidnight } from './board-date-time.js';
import { buildWeekStarts, startOfWeekMonday } from './week-boundary.js';

describe('board week boundaries', () => {
  it('uses Monday 00:00 in the configured timezone', () => {
    const now = new Date('2026-08-15T12:00:00.000Z');
    const mondayStart = startOfWeekMonday(now, 'UTC');
    expect(mondayStart.toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  it('groups closes into Asia/Tokyo weeks independently of host timezone', () => {
    const timeZone = 'Asia/Tokyo';
    const now = new Date('2026-08-15T03:00:00.000Z');
    const weekStarts = buildWeekStarts(now, 1, timeZone);
    expect(weekStarts).toHaveLength(1);
    expect(localDateKey(weekStarts[0]!, timeZone)).toBe('2026-08-10');
    expect(zonedMidnight('2026-08-10', timeZone).toISOString()).toBe(
      '2026-08-09T15:00:00.000Z',
    );
  });
});
