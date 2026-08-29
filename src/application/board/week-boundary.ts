import {
  addCalendarDaysToDateKey,
  getWeekdayInTimeZone,
  localDateKey,
  subtractCalendarDaysFromDateKey,
  zonedMidnight,
} from './board-date-time.js';

export function startOfWeekMonday(date: Date, timeZone: string): Date {
  const dateKey = localDateKey(date, timeZone);
  const weekday = getWeekdayInTimeZone(date, timeZone);
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  const mondayKey = subtractCalendarDaysFromDateKey(dateKey, daysSinceMonday, timeZone);
  return zonedMidnight(mondayKey, timeZone);
}

export function buildWeekStarts(
  now: Date,
  weeks: number,
  timeZone: string,
): readonly Date[] {
  const currentWeekStart = startOfWeekMonday(now, timeZone);
  const currentWeekKey = localDateKey(currentWeekStart, timeZone);
  const weekStarts: Date[] = [];

  for (let index = weeks - 1; index >= 0; index -= 1) {
    const weekStartKey = subtractCalendarDaysFromDateKey(currentWeekKey, index * 7, timeZone);
    weekStarts.push(zonedMidnight(weekStartKey, timeZone));
  }

  return weekStarts;
}

function nextWeekStart(weekStart: Date, timeZone: string): Date {
  const weekStartKey = localDateKey(weekStart, timeZone);
  const nextWeekStartKey = addCalendarDaysToDateKey(weekStartKey, 7, timeZone);
  return zonedMidnight(nextWeekStartKey, timeZone);
}

export function isInWeek(at: Date, weekStart: Date, timeZone: string): boolean {
  const timestamp = at.getTime();
  const start = weekStart.getTime();
  const end = nextWeekStart(weekStart, timeZone).getTime();
  return timestamp >= start && timestamp < end;
}

export function isInWeekRange(
  at: Date,
  weekStarts: readonly Date[],
  timeZone: string,
): boolean {
  if (weekStarts.length === 0) {
    return false;
  }

  const rangeStart = weekStarts[0]?.getTime() ?? 0;
  const lastWeekStart = weekStarts[weekStarts.length - 1];
  const rangeEnd =
    lastWeekStart !== undefined
      ? nextWeekStart(lastWeekStart, timeZone).getTime()
      : rangeStart;

  const timestamp = at.getTime();
  return timestamp >= rangeStart && timestamp < rangeEnd;
}
