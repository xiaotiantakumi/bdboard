import { describe, expect, it } from 'vitest';
import {
  addCalendarDaysToDateKey,
  localDateKey,
  subtractCalendarDaysFromDateKey,
  zonedMidnight,
} from './board-date-time.js';
import {
  buildWeekBoundaries,
  buildWeekStarts,
  isInWeekBounds,
  isInWeekRangeBounds,
  startOfWeekMonday,
  type WeekRange,
} from './week-boundary.js';

/**
 * bdboard-0o1e acceptance criteria: prove the new O(weeks) boundary
 * precomputation (`buildWeekBoundaries` / `isInWeekBounds` /
 * `isInWeekRangeBounds`) agrees with the OLD O(tickets x weeks) algorithm
 * (the one `bdboard-himp` profiled as the CPU hot path) across many
 * timestamps, timezones (including DST transition weeks), and weeks
 * values -- not just the handful of cases in week-boundary.test.ts.
 *
 * The "old" implementation below is a verbatim copy of `buildWeekStarts` /
 * `isInWeek` / `isInWeekRange` as they existed before this ticket (see the
 * ticket-flow.md instruction: "旧実装はテスト内に素朴実装として複製してよい").
 * It intentionally does NOT import from week-boundary.ts's current
 * (optimized) `buildWeekStarts`, so a future accidental behavior change to
 * the production code cannot silently make this comparison vacuous.
 */

function oldBuildWeekStarts(now: Date, weeks: number, timeZone: string): readonly Date[] {
  const currentWeekStart = startOfWeekMonday(now, timeZone);
  const currentWeekKey = localDateKey(currentWeekStart, timeZone);
  const weekStarts: Date[] = [];
  for (let index = weeks - 1; index >= 0; index -= 1) {
    const weekStartKey = subtractCalendarDaysFromDateKey(currentWeekKey, index * 7, timeZone);
    weekStarts.push(zonedMidnight(weekStartKey, timeZone));
  }
  return weekStarts;
}

function oldNextWeekStart(weekStart: Date, timeZone: string): Date {
  const weekStartKey = localDateKey(weekStart, timeZone);
  const nextWeekStartKey = addCalendarDaysToDateKey(weekStartKey, 7, timeZone);
  return zonedMidnight(nextWeekStartKey, timeZone);
}

function oldIsInWeek(at: Date, weekStart: Date, timeZone: string): boolean {
  const timestamp = at.getTime();
  const start = weekStart.getTime();
  const end = oldNextWeekStart(weekStart, timeZone).getTime();
  return timestamp >= start && timestamp < end;
}

function oldIsInWeekRange(
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
      ? oldNextWeekStart(lastWeekStart, timeZone).getTime()
      : rangeStart;
  const timestamp = at.getTime();
  return timestamp >= rangeStart && timestamp < rangeEnd;
}

/** Matches get-throughput-stats.ts / get-model-stats.ts's per-ticket loop:
 * scan weeks in order, return the index of the first match (or -1). */
function oldMatchedIndex(at: Date, weekStarts: readonly Date[], timeZone: string): number {
  for (let index = 0; index < weekStarts.length; index += 1) {
    const weekStart = weekStarts[index];
    if (weekStart !== undefined && oldIsInWeek(at, weekStart, timeZone)) {
      return index;
    }
  }
  return -1;
}

function newMatchedIndex(at: Date, weekRanges: readonly WeekRange[]): number {
  for (let index = 0; index < weekRanges.length; index += 1) {
    const range = weekRanges[index];
    if (range !== undefined && isInWeekBounds(at, range)) {
      return index;
    }
  }
  return -1;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface TimeZoneCase {
  readonly timeZone: string;
  readonly nows: readonly string[];
}

// Anchor "now" values per timezone, chosen to exercise:
// - every weekday of a DST-free week (so startOfWeekMonday's weekday
//   handling is covered for every offset, standing in for "different week
//   start configurations" since this project doesn't have a configurable
//   week-start weekday -- only Monday -- but the offset arithmetic is the
//   same code path)
// - the 2026 US DST spring-forward (Mar 8) and fall-back (Nov 1) transition
//   weeks for America/New_York, at several days before/within/after
// - the 2026 EU DST spring-forward (Mar 29) and fall-back (Oct 25)
//   transition weeks for Europe/London, at several days before/within/after
const TIME_ZONE_CASES: readonly TimeZoneCase[] = [
  {
    timeZone: 'UTC',
    nows: [
      '2026-01-01T12:00:00.000Z',
      '2026-06-01T12:00:00.000Z',
      '2026-06-02T12:00:00.000Z',
      '2026-06-03T12:00:00.000Z',
      '2026-06-04T12:00:00.000Z',
      '2026-06-05T12:00:00.000Z',
      '2026-06-06T12:00:00.000Z',
      '2026-06-07T12:00:00.000Z',
      '2026-12-31T12:00:00.000Z',
    ],
  },
  {
    timeZone: 'Asia/Tokyo',
    nows: [
      '2026-01-01T12:00:00.000Z',
      '2026-06-01T12:00:00.000Z',
      '2026-06-02T12:00:00.000Z',
      '2026-06-03T12:00:00.000Z',
      '2026-06-04T12:00:00.000Z',
      '2026-06-05T12:00:00.000Z',
      '2026-06-06T12:00:00.000Z',
      '2026-06-07T12:00:00.000Z',
      '2026-12-31T12:00:00.000Z',
    ],
  },
  {
    // US DST 2026: spring-forward Mar 8, fall-back Nov 1.
    timeZone: 'America/New_York',
    nows: [
      '2026-03-04T12:00:00.000Z',
      '2026-03-06T12:00:00.000Z',
      '2026-03-09T12:00:00.000Z',
      '2026-03-11T12:00:00.000Z',
      '2026-04-20T12:00:00.000Z',
      '2026-10-27T12:00:00.000Z',
      '2026-10-30T12:00:00.000Z',
      '2026-11-02T12:00:00.000Z',
      '2026-11-04T12:00:00.000Z',
      '2026-12-15T12:00:00.000Z',
    ],
  },
  {
    // EU DST 2026: spring-forward Mar 29, fall-back Oct 25.
    timeZone: 'Europe/London',
    nows: [
      '2026-03-25T12:00:00.000Z',
      '2026-03-27T12:00:00.000Z',
      '2026-03-30T12:00:00.000Z',
      '2026-04-01T12:00:00.000Z',
      '2026-04-26T12:00:00.000Z',
      '2026-10-21T12:00:00.000Z',
      '2026-10-24T12:00:00.000Z',
      '2026-10-26T12:00:00.000Z',
      '2026-10-28T12:00:00.000Z',
      '2026-12-08T12:00:00.000Z',
    ],
  },
];

const WEEKS_VALUES: readonly number[] = [1, 2, 8, 26];

describe('week-boundary: new O(weeks) boundaries vs old O(weeks^2)/per-ticket implementation', () => {
  for (const { timeZone, nows } of TIME_ZONE_CASES) {
    for (const nowIso of nows) {
      for (const weeks of WEEKS_VALUES) {
        const now = new Date(nowIso);

        it(`weekStarts match: tz=${timeZone} now=${nowIso} weeks=${weeks}`, () => {
          const expected = oldBuildWeekStarts(now, weeks, timeZone);
          const actual = buildWeekStarts(now, weeks, timeZone);
          expect(actual.map((d) => d.getTime())).toEqual(expected.map((d) => d.getTime()));

          const boundaries = buildWeekBoundaries(now, weeks, timeZone);
          expect(boundaries.weekStarts.map((d) => d.getTime())).toEqual(
            expected.map((d) => d.getTime()),
          );
          expect(boundaries.weekRanges).toHaveLength(weeks);
        });

        it(`membership matches at week-exact and DST/boundary-adjacent instants: tz=${timeZone} now=${nowIso} weeks=${weeks}`, () => {
          const oldStarts = oldBuildWeekStarts(now, weeks, timeZone);
          const { weekRanges } = buildWeekBoundaries(now, weeks, timeZone);
          expect(weekRanges).toHaveLength(oldStarts.length);

          // Test the first, a middle, and the last week explicitly -- these
          // are the weeks most likely to expose an off-by-one at the array
          // boundary; DST transition weeks land in one of these slots for
          // at least one of the `now` anchors above.
          const weekIndexesToProbe = new Set<number>([
            0,
            Math.floor((weeks - 1) / 2),
            weeks - 1,
          ]);

          for (const weekIndex of weekIndexesToProbe) {
            const range = weekRanges[weekIndex];
            const oldWeekStart = oldStarts[weekIndex];
            if (range === undefined || oldWeekStart === undefined) {
              continue;
            }

            const points: readonly Date[] = [
              new Date(range.start), // exactly at week start (inclusive)
              new Date(range.start - 1), // 1ms before start (previous week / out of range)
              new Date(range.end - 1), // last valid ms of the week (inclusive)
              new Date(range.end), // exactly at week end (exclusive -- next week / out of range)
              new Date(Math.floor((range.start + range.end) / 2)), // mid-week
            ];

            for (const at of points) {
              const oldIndex = oldMatchedIndex(at, oldStarts, timeZone);
              const newIndex = newMatchedIndex(at, weekRanges);
              expect(newIndex).toBe(oldIndex);

              const oldInRange = oldIsInWeekRange(at, oldStarts, timeZone);
              const newInRange = isInWeekRangeBounds(at, weekRanges);
              expect(newInRange).toBe(oldInRange);
            }
          }

          // Well outside the whole range on both sides.
          const outside: readonly Date[] = [
            new Date((weekRanges[0]?.start ?? 0) - MS_PER_DAY),
            new Date((weekRanges[weekRanges.length - 1]?.end ?? 0) + MS_PER_DAY),
          ];
          for (const at of outside) {
            expect(newMatchedIndex(at, weekRanges)).toBe(oldMatchedIndex(at, oldStarts, timeZone));
            expect(isInWeekRangeBounds(at, weekRanges)).toBe(
              oldIsInWeekRange(at, oldStarts, timeZone),
            );
          }
        });
      }
    }
  }

  it('DST spring-forward week is exactly 167 hours (America/New_York, Mar 8 2026)', () => {
    const timeZone = 'America/New_York';
    const now = new Date('2026-03-05T12:00:00.000Z'); // Thu, in the Mon Mar 2 - Sun Mar 8 week
    const { weekRanges } = buildWeekBoundaries(now, 1, timeZone);
    const range = weekRanges[0];
    expect(range).toBeDefined();
    expect((range!.end - range!.start) / (60 * 60 * 1000)).toBe(167);
  });

  it('DST fall-back week is exactly 169 hours (America/New_York, Nov 1 2026)', () => {
    const timeZone = 'America/New_York';
    const now = new Date('2026-10-29T12:00:00.000Z'); // Thu, in the Mon Oct 26 - Sun Nov 1 week
    const { weekRanges } = buildWeekBoundaries(now, 1, timeZone);
    const range = weekRanges[0];
    expect(range).toBeDefined();
    expect((range!.end - range!.start) / (60 * 60 * 1000)).toBe(169);
  });

  it('DST spring-forward week is exactly 167 hours (Europe/London, Mar 29 2026)', () => {
    const timeZone = 'Europe/London';
    const now = new Date('2026-03-26T12:00:00.000Z'); // Thu, in the Mon Mar 23 - Sun Mar 29 week
    const { weekRanges } = buildWeekBoundaries(now, 1, timeZone);
    const range = weekRanges[0];
    expect(range).toBeDefined();
    expect((range!.end - range!.start) / (60 * 60 * 1000)).toBe(167);
  });

  it('DST fall-back week is exactly 169 hours (Europe/London, Oct 25 2026)', () => {
    const timeZone = 'Europe/London';
    const now = new Date('2026-10-22T12:00:00.000Z'); // Thu, in the Mon Oct 19 - Sun Oct 25 week
    const { weekRanges } = buildWeekBoundaries(now, 1, timeZone);
    const range = weekRanges[0];
    expect(range).toBeDefined();
    expect((range!.end - range!.start) / (60 * 60 * 1000)).toBe(169);
  });

  it('non-DST weeks are exactly 168 hours regardless of timezone', () => {
    for (const timeZone of ['UTC', 'Asia/Tokyo', 'America/New_York', 'Europe/London']) {
      const now = new Date('2026-06-15T12:00:00.000Z');
      const { weekRanges } = buildWeekBoundaries(now, 1, timeZone);
      const range = weekRanges[0];
      expect(range).toBeDefined();
      expect((range!.end - range!.start) / (60 * 60 * 1000)).toBe(168);
    }
  });

  it('recomputes correctly when the timeZone argument changes between calls (no stale cross-call cache)', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    const tokyo = buildWeekBoundaries(now, 4, 'Asia/Tokyo');
    const newYork = buildWeekBoundaries(now, 4, 'America/New_York');
    // Different timezones must not share identical wall-clock boundaries for
    // the same `now` and `weeks` -- if a cache were incorrectly keyed only
    // by (now, weeks) and ignored timeZone, these would collide.
    expect(tokyo.weekRanges[0]?.start).not.toBe(newYork.weekRanges[0]?.start);

    // Calling again with the first timezone still reproduces the original
    // result (i.e. the second call's different timeZone didn't leak state).
    const tokyoAgain = buildWeekBoundaries(now, 4, 'Asia/Tokyo');
    expect(tokyoAgain.weekRanges.map((r) => [r.start, r.end])).toEqual(
      tokyo.weekRanges.map((r) => [r.start, r.end]),
    );
  });
});
