import { describe, expect, it } from 'vitest';
import {
  addCalendarDaysToDateKey,
  localDateKey,
  zonedMidnight,
} from './board-date-time.js';
import {
  buildWeekStarts,
  isInWeek,
  isInWeekRange,
  startOfWeekMonday,
} from './week-boundary.js';

function endOfLocalDay(dateKey: string, timeZone: string): Date {
  const nextDayKey = addCalendarDaysToDateKey(dateKey, 1, timeZone);
  return new Date(zonedMidnight(nextDayKey, timeZone).getTime() - 1);
}

function weekSundayKey(weekStart: Date, timeZone: string): string {
  return addCalendarDaysToDateKey(localDateKey(weekStart, timeZone), 6, timeZone);
}

function nextWeekMondayStart(weekStart: Date, timeZone: string): Date {
  const nextMondayKey = addCalendarDaysToDateKey(localDateKey(weekStart, timeZone), 7, timeZone);
  return zonedMidnight(nextMondayKey, timeZone);
}

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

  describe('America/New_York DST spring-forward week (167 hours)', () => {
    const timeZone = 'America/New_York';

    it('isInWeek keeps Sunday late night in the week and excludes next Monday', () => {
      const weekStart = startOfWeekMonday(zonedMidnight('2026-03-06', timeZone), timeZone);
      const sundayLate = endOfLocalDay(weekSundayKey(weekStart, timeZone), timeZone);
      const nextMondayStart = nextWeekMondayStart(weekStart, timeZone);
      const nextWeekEarly = new Date(nextMondayStart.getTime() + 30 * 60 * 1000);

      expect(isInWeek(sundayLate, weekStart, timeZone)).toBe(true);
      expect(isInWeek(nextMondayStart, weekStart, timeZone)).toBe(false);
      expect(isInWeek(nextWeekEarly, weekStart, timeZone)).toBe(false);
    });

    it('isInWeekRange uses calendar week ends across the DST spring-forward week', () => {
      const now = zonedMidnight('2026-03-06', timeZone);
      const weekStarts = buildWeekStarts(now, 2, timeZone);
      const dstWeekStart = weekStarts[weekStarts.length - 1]!;
      const sundayLate = endOfLocalDay(weekSundayKey(dstWeekStart, timeZone), timeZone);
      const nextMondayStart = nextWeekMondayStart(dstWeekStart, timeZone);
      const nextWeekEarly = new Date(nextMondayStart.getTime() + 30 * 60 * 1000);

      expect(isInWeekRange(sundayLate, weekStarts, timeZone)).toBe(true);
      expect(isInWeekRange(nextMondayStart, weekStarts, timeZone)).toBe(false);
      expect(isInWeekRange(nextWeekEarly, weekStarts, timeZone)).toBe(false);
    });
  });

  describe('America/New_York DST fall-back week (169 hours)', () => {
    const timeZone = 'America/New_York';

    it('isInWeek keeps the extra fall-back hour inside the week', () => {
      const weekStart = startOfWeekMonday(zonedMidnight('2026-10-28', timeZone), timeZone);
      const sundayLate = endOfLocalDay(weekSundayKey(weekStart, timeZone), timeZone);
      const nextMondayStart = nextWeekMondayStart(weekStart, timeZone);
      const lastHourOfWeek = new Date(nextMondayStart.getTime() - 30 * 60 * 1000);

      expect(isInWeek(sundayLate, weekStart, timeZone)).toBe(true);
      expect(isInWeek(lastHourOfWeek, weekStart, timeZone)).toBe(true);
      expect(isInWeek(nextMondayStart, weekStart, timeZone)).toBe(false);
    });

    it('isInWeekRange includes the extra fall-back hour before next Monday', () => {
      const now = zonedMidnight('2026-10-28', timeZone);
      const weekStarts = buildWeekStarts(now, 2, timeZone);
      const dstWeekStart = weekStarts[weekStarts.length - 1]!;
      const sundayLate = endOfLocalDay(weekSundayKey(dstWeekStart, timeZone), timeZone);
      const nextMondayStart = nextWeekMondayStart(dstWeekStart, timeZone);
      const lastHourOfWeek = new Date(nextMondayStart.getTime() - 30 * 60 * 1000);

      expect(isInWeekRange(sundayLate, weekStarts, timeZone)).toBe(true);
      expect(isInWeekRange(lastHourOfWeek, weekStarts, timeZone)).toBe(true);
      expect(isInWeekRange(nextMondayStart, weekStarts, timeZone)).toBe(false);
    });
  });
});
