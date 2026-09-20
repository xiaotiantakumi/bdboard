// bdboard-sso1.12: dto.ts のモジュール分割。スループット・モデル別集計・CFD
// (累積フロー図) の DTO。stats-routes.ts が参照する (barrel 経由)。ハーネス KPI は
// 同じ resource だが行数の都合で harness-kpi.ts に分けている。
import type {
  AgeDistribution,
  ProjectThroughputStats,
  ThroughputStats,
  WeeklyCloseCount,
} from '../../../application/board/get-throughput-stats.js';
import type { CfdDayEntry, CfdStats, ProjectCfdStats } from '../../../application/board/get-cfd-stats.js';
import type {
  ModelStats,
  StageModelCounts,
  WeeklyModelCloseCounts,
} from '../../../application/board/get-model-stats.js';

export interface WeeklyCloseCountDto {
  weekStart: string;
  count: number;
}

export interface AgeDistributionDto {
  d0to1: number;
  d1to7: number;
  d7to30: number;
  d30plus: number;
}

export interface ProjectThroughputStatsDto {
  projectId: string;
  projectName: string;
  weeklyCloses: WeeklyCloseCountDto[];
  openTicketAge: AgeDistributionDto;
}

export interface ThroughputStatsDto {
  projects: ProjectThroughputStatsDto[];
  totals: {
    weeklyCloses: WeeklyCloseCountDto[];
    openTicketAge: AgeDistributionDto;
  };
}

export interface WeeklyModelCloseCountsDto {
  weekStart: string;
  counts: Record<string, number>;
}

export interface StageModelCountsDto {
  stage: string;
  counts: Record<string, number>;
}

export interface ModelStatsDto {
  weeklyCloses: WeeklyModelCloseCountsDto[];
  stageModelDistribution: StageModelCountsDto[];
}

export interface CfdDayEntryDto {
  date: string;
  counts: Record<string, number>;
}

export interface ProjectCfdStatsDto {
  projectId: string;
  projectName: string;
  days: CfdDayEntryDto[];
}

export interface CfdStatsDto {
  projects: ProjectCfdStatsDto[];
  totals: CfdDayEntryDto[];
}

function toWeeklyCloseCountDto(entry: WeeklyCloseCount): WeeklyCloseCountDto {
  return {
    weekStart: entry.weekStart.toISOString(),
    count: entry.count,
  };
}

function toAgeDistributionDto(distribution: AgeDistribution): AgeDistributionDto {
  return {
    d0to1: distribution.d0to1,
    d1to7: distribution.d1to7,
    d7to30: distribution.d7to30,
    d30plus: distribution.d30plus,
  };
}

function toProjectThroughputStatsDto(
  stats: ProjectThroughputStats,
): ProjectThroughputStatsDto {
  return {
    projectId: stats.project.id,
    projectName: stats.project.name,
    weeklyCloses: stats.weeklyCloses.map(toWeeklyCloseCountDto),
    openTicketAge: toAgeDistributionDto(stats.openTicketAge),
  };
}

export function toThroughputStatsDto(stats: ThroughputStats): ThroughputStatsDto {
  return {
    projects: stats.projects.map(toProjectThroughputStatsDto),
    totals: {
      weeklyCloses: stats.totals.weeklyCloses.map(toWeeklyCloseCountDto),
      openTicketAge: toAgeDistributionDto(stats.totals.openTicketAge),
    },
  };
}

function toWeeklyModelCloseCountsDto(
  entry: WeeklyModelCloseCounts,
): WeeklyModelCloseCountsDto {
  return {
    weekStart: entry.weekStart.toISOString(),
    counts: { ...entry.counts },
  };
}

function toStageModelCountsDto(entry: StageModelCounts): StageModelCountsDto {
  return {
    stage: entry.stage,
    counts: { ...entry.counts },
  };
}

export function toModelStatsDto(stats: ModelStats): ModelStatsDto {
  return {
    weeklyCloses: stats.weeklyCloses.map(toWeeklyModelCloseCountsDto),
    stageModelDistribution: stats.stageModelDistribution.map(toStageModelCountsDto),
  };
}

function toCfdDayEntryDto(entry: CfdDayEntry): CfdDayEntryDto {
  const counts: Record<string, number> = {};
  for (const [status, count] of Object.entries(entry.counts)) {
    if (count !== undefined) {
      counts[status] = count;
    }
  }
  return {
    date: entry.date,
    counts,
  };
}

function toProjectCfdStatsDto(stats: ProjectCfdStats): ProjectCfdStatsDto {
  return {
    projectId: stats.project.id,
    projectName: stats.project.name,
    days: stats.days.map(toCfdDayEntryDto),
  };
}

export function toCfdStatsDto(stats: CfdStats): CfdStatsDto {
  return {
    projects: stats.projects.map(toProjectCfdStatsDto),
    totals: stats.totals.map(toCfdDayEntryDto),
  };
}
