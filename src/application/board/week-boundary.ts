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
 * Each week's end is computed from *that week's own* key with the same
 * formula the old `nextWeekStart` used internally
 * (`addCalendarDaysToDateKey(weekKey, 7, timeZone)` then `zonedMidnight`),
 * evaluated once per week here instead of once per ticket x week. Strictly,
 * `nextWeekStart` re-derives the key via `localDateKey(zonedMidnight(weekStart))`
 * first, which only round-trips back to the same key when local midnight for
 * that key isn't itself skipped by a DST transition -- a handful of dates
 * worldwide, but always a Sunday, never a Monday (checked across all IANA
 * zones). Every key here is a Monday (week starts), so the round-trip always
 * holds and `isInWeekBounds`/`isInWeekRangeBounds` below match
 * `isInWeek`/`isInWeekRange` exactly while doing zero further Intl work. If
 * this project ever supports a non-Monday week start, re-verify this.
 * Computing every week's own end (rather than reusing the next week's start,
 * which is provably equal but would need its own proof to rely on) costs
 * roughly 2x the calendar-day work here -- immaterial at the `weeks` sizes
 * this project uses, and it keeps this function's correctness independent of
 * `isInWeek`'s day-math instead of assuming forward/backward are exact
 * inverses.
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

  const keysOldestFirst: string[] = [currentWeekKey];
  let previousKey = currentWeekKey;
  for (let index = 1; index < weeks; index += 1) {
    previousKey = subtractCalendarDaysFromDateKey(previousKey, 7, timeZone);
    keysOldestFirst.push(previousKey);
  }
  keysOldestFirst.reverse();

  const weekStarts: Date[] = [];
  const weekRanges: WeekRange[] = [];
  for (const key of keysOldestFirst) {
    const start = zonedMidnight(key, timeZone);
    const endKey = addCalendarDaysToDateKey(key, 7, timeZone);
    const end = zonedMidnight(endKey, timeZone);
    weekStarts.push(start);
    weekRanges.push({ start: start.getTime(), end: end.getTime() });
  }

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
