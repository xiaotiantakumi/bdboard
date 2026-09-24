import { getCachedDateTimeFormat } from '../../domain/intl-format-cache.js';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function localDateKey(date: Date, timeZone: string): string {
  return getCachedDateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function getTimeZoneOffsetMs(at: Date, timeZone: string): number {
  const dtf = getCachedDateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(at);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }
  const asUtc = Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day),
    Number(lookup.hour),
    Number(lookup.minute),
    Number(lookup.second),
  );
  return asUtc - at.getTime();
}

export function zonedMidnight(dateKey: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const offset1 = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  const candidate1 = utcGuess - offset1;
  const offset2 = getTimeZoneOffsetMs(new Date(candidate1), timeZone);
  if (offset2 === offset1) {
    return new Date(candidate1);
  }
  const candidate2 = utcGuess - offset2;
  if (localDateKey(new Date(candidate2), timeZone) === dateKey) {
    return new Date(candidate2);
  }
  // Local midnight for dateKey does not exist: this is a "spring forward at
  // 00:00" DST transition day (e.g. America/Santiago), where the clock jumps
  // from 23:59:59 the day before straight to 01:00:00. candidate2 above --
  // computed using the post-transition offset -- lands back inside the
  // skipped hour(s) and reads as the previous day. candidate1 is exactly the
  // transition instant instead, which is the first local instant that
  // belongs to dateKey (e.g. 01:00), keeping
  // localDateKey(zonedMidnight(key, tz), tz) === key an invariant even on
  // these days (verified across all 86 affected (dateKey, timeZone) pairs,
  // 2015-2030, all IANA zones -- see board-date-time.test.ts).
  return new Date(candidate1);
}

export function getWeekdayInTimeZone(date: Date, timeZone: string): number {
  const weekday = getCachedDateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(date);
  return WEEKDAY_MAP[weekday] ?? 0;
}

export function subtractCalendarDaysFromDateKey(
  dateKey: string,
  days: number,
  timeZone: string,
): string {
  let key = dateKey;
  for (let index = 0; index < days; index += 1) {
    const midnight = zonedMidnight(key, timeZone);
    key = localDateKey(new Date(midnight.getTime() - 1), timeZone);
  }
  return key;
}

// 36h clears both a 23h spring-forward day and a 25h fall-back day (> longest
// local calendar day, < two normal days) without landing on the day after next.
const CALENDAR_DAY_ADVANCE_MS = 36 * 60 * 60 * 1000;

export function addCalendarDaysToDateKey(
  dateKey: string,
  days: number,
  timeZone: string,
): string {
  let key = dateKey;
  for (let index = 0; index < days; index += 1) {
    const midnight = zonedMidnight(key, timeZone);
    key = localDateKey(new Date(midnight.getTime() + CALENDAR_DAY_ADVANCE_MS), timeZone);
  }
  return key;
}
