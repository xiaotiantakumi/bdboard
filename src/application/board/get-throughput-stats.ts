import { getBoardTimeZone } from '../../config/board-timezone.js';
import type { Project } from '../../domain/project.js';
import type { Ticket } from '../../domain/ticket.js';
import type { BoardCache } from '../ports/board-cache.js';
import { createYieldGate, forEachChunked, type YieldGate } from './aggregation-yield.js';
import { MS_PER_DAY } from './board-date-time.js';
import {
  buildWeekBoundaries,
  isInWeekBounds,
  isInWeekRangeBounds,
  type WeekRange,
} from './week-boundary.js';

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
  readonly timeZone?: string;
}

const DEFAULT_WEEKS = 8;

const EMPTY_AGE_DISTRIBUTION: AgeDistribution = {
  d0to1: 0,
  d1to7: 0,
  d7to30: 0,
  d30plus: 0,
};

function createEmptyWeeklyCloses(weekStarts: readonly Date[]): WeeklyCloseCount[] {
  return weekStarts.map((weekStart) => ({ weekStart, count: 0 }));
}

// bdboard-ve1y: forEachChunked 経由でチケットを走査する。同じ tickets 配列を
// 同じ順序で1件ずつ処理するので、結果は元の for-of ループと同一。gate は
// getThroughputStats がプロジェクトをまたいで共有するので、1プロジェクトの
// チケット数が chunk size 未満でも、全プロジェクト通算でチャンク境界に
// 達すれば yield する (bdboard-ve1y: 実運用はプロジェクト数が多く1件あたりの
// チケット数は少ない構成が多いため、プロジェクト単位でカウンタをリセットする
// と実質 yield されないケースがあった)。
async function countWeeklyCloses(
  tickets: readonly Ticket[],
  weekStarts: readonly Date[],
  weekRanges: readonly WeekRange[],
  gate: YieldGate,
): Promise<WeeklyCloseCount[]> {
  const counts = createEmptyWeeklyCloses(weekStarts);

  await forEachChunked(tickets, (ticket) => {
    if (ticket.closedAt === undefined) {
      return;
    }
    if (!isInWeekRangeBounds(ticket.closedAt, weekRanges)) {
      return;
    }

    for (let index = 0; index < weekRanges.length; index += 1) {
      const range = weekRanges[index];
      if (range !== undefined && isInWeekBounds(ticket.closedAt, range)) {
        const current = counts[index];
        if (current !== undefined) {
          counts[index] = { weekStart: current.weekStart, count: current.count + 1 };
        }
        break;
      }
    }
  }, gate);

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

async function countOpenTicketAge(
  tickets: readonly Ticket[],
  now: Date,
  gate: YieldGate,
): Promise<AgeDistribution> {
  const distribution: { -readonly [K in keyof AgeDistribution]: number } = {
    ...EMPTY_AGE_DISTRIBUTION,
  };

  await forEachChunked(tickets, (ticket) => {
    if (ticket.closedAt !== undefined) {
      return;
    }

    const bucket = ageBucket(ticket.createdAt, now);
    distribution[bucket] += 1;
  }, gate);

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

export async function getThroughputStats(
  cache: BoardCache,
  now: Date,
  options?: GetThroughputStatsOptions,
): Promise<ThroughputStats> {
  const weeks = Math.max(1, options?.weeks ?? DEFAULT_WEEKS);
  const timeZone = options?.timeZone ?? getBoardTimeZone();
  const { weekStarts, weekRanges } = buildWeekBoundaries(now, weeks, timeZone);
  const projectIdFilter = options?.projectIds;

  // bdboard-mkkx: listProjectsChunked() があればそちらを使う (SQLite読み出し+
  // チケットJSONパースをプロジェクト単位でチャンク化し、/api/health 等の他
  // リクエストを長時間待たせない)。無ければ (インメモリ fake 等) listProjects()
  // に同じ結果でフォールバックする。
  let entries = cache.listProjectsChunked !== undefined
    ? await cache.listProjectsChunked()
    : cache.listProjects();
  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const projects: ProjectThroughputStats[] = [];
  let totalsWeekly = createEmptyWeeklyCloses(weekStarts);
  let totalsAge: AgeDistribution = { ...EMPTY_AGE_DISTRIBUTION };
  // bdboard-ve1y: 全プロジェクト通算でチャンク境界を数える共有 gate。
  const gate = createYieldGate();

  for (const entry of entries) {
    const weeklyCloses = await countWeeklyCloses(entry.tickets, weekStarts, weekRanges, gate);
    const openTicketAge = await countOpenTicketAge(entry.tickets, now, gate);

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
