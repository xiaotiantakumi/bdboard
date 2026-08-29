import { getBoardTimeZone } from '../../config/board-timezone.js';
import type { Project } from '../../domain/project.js';
import type { Status } from '../../domain/status.js';
import type { BoardCache } from '../ports/board-cache.js';
import {
  localDateKey,
  subtractCalendarDaysFromDateKey,
} from './board-date-time.js';

export interface CfdDayEntry {
  readonly date: string;
  readonly counts: Readonly<Partial<Record<Status, number>>>;
}

export interface ProjectCfdStats {
  readonly project: Project;
  readonly days: readonly CfdDayEntry[];
}

export interface CfdStats {
  readonly projects: readonly ProjectCfdStats[];
  readonly totals: readonly CfdDayEntry[];
}

export interface GetCfdStatsOptions {
  readonly projectIds?: readonly string[];
  readonly days?: number;
  readonly timeZone?: string;
}

const DEFAULT_DAYS = 30;

function cutoffDate(now: Date, days: number, timeZone: string): string {
  const todayKey = localDateKey(now, timeZone);
  return subtractCalendarDaysFromDateKey(todayKey, days - 1, timeZone);
}

function isOnOrAfter(date: string, cutoff: string): boolean {
  return date >= cutoff;
}

function buildDayEntry(
  date: string,
  statusCounts: ReadonlyMap<string, number>,
): CfdDayEntry {
  const counts: Partial<Record<Status, number>> = {};
  for (const [status, count] of statusCounts) {
    counts[status as Status] = count;
  }
  return { date, counts };
}

export function getCfdStats(
  cache: BoardCache,
  now: Date,
  options?: GetCfdStatsOptions,
): CfdStats {
  const days = Math.max(1, options?.days ?? DEFAULT_DAYS);
  const timeZone = options?.timeZone ?? getBoardTimeZone();
  const cutoff = cutoffDate(now, days, timeZone);
  const projectIdFilter = options?.projectIds;

  let entries = cache.listProjects();
  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const liveProjectIds = new Set(entries.map((entry) => entry.project.id));

  const snapshots = cache.listCfdSnapshots(
    projectIdFilter !== undefined ? projectIdFilter : undefined,
  ).filter((row) => isOnOrAfter(row.snapshotDate, cutoff));

  const byProject = new Map<string, Map<string, Map<string, number>>>();
  const totalsByDate = new Map<string, Map<string, number>>();

  for (const row of snapshots) {
    let projectDates = byProject.get(row.projectId);
    if (projectDates === undefined) {
      projectDates = new Map();
      byProject.set(row.projectId, projectDates);
    }

    let dateCounts = projectDates.get(row.snapshotDate);
    if (dateCounts === undefined) {
      dateCounts = new Map();
      projectDates.set(row.snapshotDate, dateCounts);
    }
    dateCounts.set(row.status, row.count);

    if (liveProjectIds.has(row.projectId)) {
      let totalDateCounts = totalsByDate.get(row.snapshotDate);
      if (totalDateCounts === undefined) {
        totalDateCounts = new Map();
        totalsByDate.set(row.snapshotDate, totalDateCounts);
      }
      totalDateCounts.set(row.status, (totalDateCounts.get(row.status) ?? 0) + row.count);
    }
  }

  const projects: ProjectCfdStats[] = entries.map((entry) => {
    const projectDates = byProject.get(entry.project.id);
    const dayEntries: CfdDayEntry[] = [];

    if (projectDates !== undefined) {
      const sortedDates = [...projectDates.keys()].sort();
      for (const date of sortedDates) {
        const statusCounts = projectDates.get(date);
        if (statusCounts !== undefined) {
          dayEntries.push(buildDayEntry(date, statusCounts));
        }
      }
    }

    return {
      project: entry.project,
      days: dayEntries,
    };
  });

  const totals: CfdDayEntry[] = [...totalsByDate.keys()]
    .sort()
    .map((date) => {
      const statusCounts = totalsByDate.get(date);
      return buildDayEntry(date, statusCounts ?? new Map());
    });

  return { projects, totals };
}
