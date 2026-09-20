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

/** Half-open millisecond bounds for one calendar week: `[start, end)`. */
export interface WeekRange {
  readonly start: number;
  readonly end: number;
}

export interface WeekBoundaries {
  /** Monday-local-midnight `Date`s, oldest first (same order as `buildWeekStarts`). */
  readonly weekStarts: readonly Date[];
  /** `[start, end)` ms bounds, index-aligned with `weekStarts`. */
  readonly weekRanges: readonly WeekRange[];
}

/**
 * Computes `weekStarts` and their `[start, end)` millisecond ranges in a
 * single O(weeks) pass of calendar-day math (bdboard-0o1e -- previously
 * `buildWeekStarts` alone was O(weeks^2), and per-ticket boundary checks
 * re-derived each week's end via Intl-backed calendar math for every
 * ticket x week pair).
 *
 * Each week's start is obtained by chaining single `subtractCalendarDaysFromDateKey`
 * calls 7 days apart from the current week backward -- chaining N "subtract 7"
 * calls performs the exact same sequence of atomic single-day decrements as
 * the old code's one-shot `subtractCalendarDaysFromDateKey(currentWeekKey, index * 7)`
 * per index, so the resulting `Date`s are identical, just computed once each
 * instead of recomputed from scratch per index (O(weeks) total instead of
 * O(weeks^2)).
 *
 * Each week's end is computed with the exact same formula the old
 * `nextWeekStart` used internally (`addCalendarDaysToDateKey(weekKey, 7, timeZone)`
 * then `zonedMidnight`), just evaluated once per week here instead of once
 * per ticket x week -- so `isInWeekBounds`/`isInWeekRangeBounds` below match
 * `isInWeek`/`isInWeekRange` exactly while doing zero further Intl work.
 */
export function buildWeekBoundaries(
  now: Date,
  weeks: number,
  timeZone: string,
): WeekBoundaries {
  if (weeks <= 0) {
    return { weekStarts: [], weekRanges: [] };
  }

  const currentWeekStart = startOfWeekMonday(now, timeZone);
  const currentWeekKey = localDateKey(currentWeekStart, timeZone);

  const keysNewestFirst: string[] = [currentWeekKey];
  for (let index = 1; index < weeks; index += 1) {
    const previous = keysNewestFirst[index - 1] as string;
    keysNewestFirst.push(subtractCalendarDaysFromDateKey(previous, 7, timeZone));
  }
  const keysOldestFirst = [...keysNewestFirst].reverse();

  const weekStarts = keysOldestFirst.map((key) => zonedMidnight(key, timeZone));
  const weekRanges = keysOldestFirst.map((key, index) => {
    const endKey = addCalendarDaysToDateKey(key, 7, timeZone);
    return {
      start: weekStarts[index]!.getTime(),
      end: zonedMidnight(endKey, timeZone).getTime(),
    };
  });

  return { weekStarts, weekRanges };
}

export function buildWeekStarts(
  now: Date,
  weeks: number,
  timeZone: string,
): readonly Date[] {
  return buildWeekBoundaries(now, weeks, timeZone).weekStarts;
}

function nextWeekStart(weekStart: Date, timeZone: string): Date {
  const weekStartKey = localDateKey(weekStart, timeZone);
  const nextWeekStartKey = addCalendarDaysToDateKey(weekStartKey, 7, timeZone);
  return zonedMidnight(nextWeekStartKey, timeZone);
}

/** @deprecated Kept for existing callers/tests. Hot paths should precompute
 * `WeekRange`s via `buildWeekBoundaries` and use `isInWeekBounds` instead --
 * this re-derives the week's end via Intl-backed calendar math on every call. */
export function isInWeek(at: Date, weekStart: Date, timeZone: string): boolean {
  const timestamp = at.getTime();
  const start = weekStart.getTime();
  const end = nextWeekStart(weekStart, timeZone).getTime();
  return timestamp >= start && timestamp < end;
}

/** @deprecated Kept for existing callers/tests. Hot paths should precompute
 * `WeekRange`s via `buildWeekBoundaries` and use `isInWeekRangeBounds` instead --
 * this re-derives the range's end via Intl-backed calendar math on every call. */
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

/** O(1) numeric membership check against a precomputed `WeekRange` -- no Intl. */
export function isInWeekBounds(at: Date, range: WeekRange): boolean {
  const timestamp = at.getTime();
  return timestamp >= range.start && timestamp < range.end;
}

/** O(1) numeric membership check against the full precomputed range set -- no Intl. */
export function isInWeekRangeBounds(
  at: Date,
  weekRanges: readonly WeekRange[],
): boolean {
  if (weekRanges.length === 0) {
    return false;
  }

  const rangeStart = weekRanges[0]?.start ?? 0;
  const last = weekRanges[weekRanges.length - 1];
  const rangeEnd = last?.end ?? rangeStart;

  const timestamp = at.getTime();
  return timestamp >= rangeStart && timestamp < rangeEnd;
}
