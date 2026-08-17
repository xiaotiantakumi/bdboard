import type { Project } from '../../domain/project.js';
import type { Ticket } from '../../domain/ticket.js';
import type { BoardCache } from '../ports/board-cache.js';

export interface WeeklyCloseCount {
  readonly weekStart: Date;
  readonly count: number;
}

export interface AgeDistribution {
  readonly d0to1: number;
  readonly d1to7: number;
  readonly d7to30: number;
  readonly d30plus: number;
}

export interface ProjectThroughputStats {
  readonly project: Project;
  readonly weeklyCloses: readonly WeeklyCloseCount[];
  readonly openTicketAge: AgeDistribution;
}

export interface ThroughputStats {
  readonly projects: readonly ProjectThroughputStats[];
  readonly totals: {
    readonly weeklyCloses: readonly WeeklyCloseCount[];
    readonly openTicketAge: AgeDistribution;
  };
}

export interface GetThroughputStatsOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
  readonly weeks?: number;
}

const DEFAULT_WEEKS = 8;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const EMPTY_AGE_DISTRIBUTION: AgeDistribution = {
  d0to1: 0,
  d1to7: 0,
  d7to30: 0,
  d30plus: 0,
};

function startOfWeekMonday(date: Date): Date {
  const weekStart = new Date(date);
  const day = weekStart.getDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - daysSinceMonday);
  return weekStart;
}

function buildWeekStarts(now: Date, weeks: number): readonly Date[] {
  const currentWeekStart = startOfWeekMonday(now);
  const weekStarts: Date[] = [];

  for (let index = weeks - 1; index >= 0; index -= 1) {
    const weekStart = new Date(currentWeekStart);
    weekStart.setDate(weekStart.getDate() - index * 7);
    weekStarts.push(weekStart);
  }

  return weekStarts;
}

function isInWeek(at: Date, weekStart: Date): boolean {
  const timestamp = at.getTime();
  const start = weekStart.getTime();
  const end = start + 7 * MS_PER_DAY;
  return timestamp >= start && timestamp < end;
}

function isInWeekRange(at: Date, weekStarts: readonly Date[]): boolean {
  if (weekStarts.length === 0) {
    return false;
  }

  const rangeStart = weekStarts[0]?.getTime() ?? 0;
  const lastWeekStart = weekStarts[weekStarts.length - 1];
  const rangeEnd =
    lastWeekStart !== undefined
      ? lastWeekStart.getTime() + 7 * MS_PER_DAY
      : rangeStart;

  const timestamp = at.getTime();
  return timestamp >= rangeStart && timestamp < rangeEnd;
}

function createEmptyWeeklyCloses(weekStarts: readonly Date[]): WeeklyCloseCount[] {
  return weekStarts.map((weekStart) => ({ weekStart, count: 0 }));
}

function countWeeklyCloses(
  tickets: readonly Ticket[],
  weekStarts: readonly Date[],
): WeeklyCloseCount[] {
  const counts = createEmptyWeeklyCloses(weekStarts);

  for (const ticket of tickets) {
    if (ticket.closedAt === undefined) {
      continue;
    }
    if (!isInWeekRange(ticket.closedAt, weekStarts)) {
      continue;
    }

    for (let index = 0; index < weekStarts.length; index += 1) {
      const weekStart = weekStarts[index];
      if (weekStart !== undefined && isInWeek(ticket.closedAt, weekStart)) {
        const current = counts[index];
        if (current !== undefined) {
          counts[index] = { weekStart, count: current.count + 1 };
        }
        break;
      }
    }
  }

  return counts;
}

// Age buckets are lower-inclusive and upper-exclusive:
// age < 1 → d0to1, 1 <= age < 7 → d1to7, 7 <= age < 30 → d7to30, 30 <= age → d30plus.
function ageBucket(createdAt: Date, now: Date): keyof AgeDistribution {
  const ageDays = (now.getTime() - createdAt.getTime()) / MS_PER_DAY;

  if (ageDays < 1) {
    return 'd0to1';
  }
  if (ageDays < 7) {
    return 'd1to7';
  }
  if (ageDays < 30) {
    return 'd7to30';
  }
  return 'd30plus';
}

function countOpenTicketAge(
  tickets: readonly Ticket[],
  now: Date,
): AgeDistribution {
  const distribution: { -readonly [K in keyof AgeDistribution]: number } = {
    ...EMPTY_AGE_DISTRIBUTION,
  };

  for (const ticket of tickets) {
    if (ticket.closedAt !== undefined) {
      continue;
    }

    const bucket = ageBucket(ticket.createdAt, now);
    distribution[bucket] += 1;
  }

  return distribution;
}

function mergeAgeDistributions(
  left: AgeDistribution,
  right: AgeDistribution,
): AgeDistribution {
  return {
    d0to1: left.d0to1 + right.d0to1,
    d1to7: left.d1to7 + right.d1to7,
    d7to30: left.d7to30 + right.d7to30,
    d30plus: left.d30plus + right.d30plus,
  };
}

function mergeWeeklyCloses(
  left: readonly WeeklyCloseCount[],
  right: readonly WeeklyCloseCount[],
): WeeklyCloseCount[] {
  return left.map((entry, index) => ({
    weekStart: entry.weekStart,
    count: entry.count + (right[index]?.count ?? 0),
  }));
}

export function getThroughputStats(
  cache: BoardCache,
  now: Date,
  options?: GetThroughputStatsOptions,
): ThroughputStats {
  const weeks = Math.max(1, options?.weeks ?? DEFAULT_WEEKS);
  const weekStarts = buildWeekStarts(now, weeks);
  const projectIdFilter = options?.projectIds;

  let entries = cache.listProjects();
  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const projects: ProjectThroughputStats[] = [];
  let totalsWeekly = createEmptyWeeklyCloses(weekStarts);
  let totalsAge: AgeDistribution = { ...EMPTY_AGE_DISTRIBUTION };

  for (const entry of entries) {
    const weeklyCloses = countWeeklyCloses(entry.tickets, weekStarts);
    const openTicketAge = countOpenTicketAge(entry.tickets, now);

    projects.push({
      project: entry.project,
      weeklyCloses,
      openTicketAge,
    });

    totalsWeekly = mergeWeeklyCloses(totalsWeekly, weeklyCloses);
    totalsAge = mergeAgeDistributions(totalsAge, openTicketAge);
  }

  return {
    projects,
    totals: {
      weeklyCloses: totalsWeekly,
      openTicketAge: totalsAge,
    },
  };
}
