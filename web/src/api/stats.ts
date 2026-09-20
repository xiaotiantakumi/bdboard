import { fetchJson } from './http';

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

export function fetchThroughputStats(
  weeks = 8,
  projectIds: readonly string[] = [],
): Promise<ThroughputStatsDto> {
  const searchParams = new URLSearchParams();
  searchParams.set('weeks', String(weeks));
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  return fetchJson<ThroughputStatsDto>(`/api/stats?${searchParams.toString()}`);
}

export function fetchModelStats(
  weeks = 8,
  projectIds: readonly string[] = [],
): Promise<ModelStatsDto> {
  const searchParams = new URLSearchParams();
  searchParams.set('weeks', String(weeks));
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  return fetchJson<ModelStatsDto>(`/api/model-stats?${searchParams.toString()}`);
}

export function fetchCfdStats(
  days = 30,
  projectIds: readonly string[] = [],
): Promise<CfdStatsDto> {
  const searchParams = new URLSearchParams();
  searchParams.set('days', String(days));
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  return fetchJson<CfdStatsDto>(`/api/cfd?${searchParams.toString()}`);
}
