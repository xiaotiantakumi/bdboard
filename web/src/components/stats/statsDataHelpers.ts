import type {
  CfdDayEntryDto,
  ModelStatsDto,
  ProjectCfdStatsDto,
  ThroughputStatsDto,
} from '../../api';
import { hasAnyOpenTickets, hasAnyWeeklyCloses } from '../throughputStatsFormatting';
import { hasAnyCfdData } from './cfdHelpers';

export function hasAnyStatsData(stats: ThroughputStatsDto): boolean {
  if (hasAnyWeeklyCloses(stats.totals.weeklyCloses)) {
    return true;
  }
  if (hasAnyOpenTickets(stats.totals.openTicketAge)) {
    return true;
  }
  return stats.projects.some(
    (project) =>
      hasAnyWeeklyCloses(project.weeklyCloses) ||
      hasAnyOpenTickets(project.openTicketAge),
  );
}

export function hasAnyDisplayedData(
  stats: ThroughputStatsDto | undefined,
  cfdStats: { totals: readonly CfdDayEntryDto[] } | undefined,
): boolean {
  if (stats !== undefined && hasAnyStatsData(stats)) {
    return true;
  }
  if (cfdStats !== undefined && hasAnyCfdData(cfdStats.totals)) {
    return true;
  }
  return false;
}

export function findProjectCfdDays(
  cfdStats: { projects: readonly ProjectCfdStatsDto[] } | undefined,
  projectId: string,
): readonly CfdDayEntryDto[] {
  return cfdStats?.projects.find((project) => project.projectId === projectId)?.days ?? [];
}

export function collectModelNames(
  weeklyCloses: readonly { counts: Record<string, number> }[],
  stageDistribution: readonly { counts: Record<string, number> }[],
): readonly string[] {
  const names = new Set<string>();
  for (const entry of weeklyCloses) {
    for (const model of Object.keys(entry.counts)) {
      names.add(model);
    }
  }
  for (const entry of stageDistribution) {
    for (const model of Object.keys(entry.counts)) {
      names.add(model);
    }
  }
  return [...names].sort();
}

export function hasAnyModelStatsData(stats: ModelStatsDto): boolean {
  const hasWeekly = stats.weeklyCloses.some(
    (entry) => Object.keys(entry.counts).length > 0,
  );
  const hasStage = stats.stageModelDistribution.some(
    (entry) => Object.keys(entry.counts).length > 0,
  );
  return hasWeekly || hasStage;
}
