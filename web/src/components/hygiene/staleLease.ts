// bdboard-sso1.11: HygienePanel.tsx から stale lease / reclaim 表示の純粋関数を
// 移動しただけのファイル。挙動は一切変えていない。
import type { LeaseHealthDto, ReclaimProjectStatusDto, StaleLeaseDto } from '../../api';
import { formatActivityTime } from '../activityFeedFormatting';

export function formatStaleDuration(staleForMs: number): string {
  if (staleForMs < 60_000) {
    return `${Math.max(1, Math.floor(staleForMs / 1000))}秒`;
  }
  if (staleForMs < 60 * 60_000) {
    return `${Math.floor(staleForMs / 60_000)}分`;
  }
  const hours = Math.floor(staleForMs / (60 * 60_000));
  const minutes = Math.floor((staleForMs % (60 * 60_000)) / 60_000);
  if (minutes === 0) {
    return `${hours}時間`;
  }
  return `${hours}時間${minutes}分`;
}

export function buildStaleLeaseMessage(staleLease: StaleLeaseDto): string {
  return `lease 失効から ${formatStaleDuration(staleLease.staleForMs)}`;
}

export function filterReclaimProjects(
  leaseHealth: LeaseHealthDto | undefined,
  projectIds: readonly string[],
): readonly ReclaimProjectStatusDto[] {
  const projects = leaseHealth?.reclaim.projects ?? [];
  if (projectIds.length === 0) {
    return projects;
  }
  const filterSet = new Set(projectIds);
  return projects.filter((project) => filterSet.has(project.projectId));
}

export function selectReclaimProblemProjects(
  reclaimProjects: readonly ReclaimProjectStatusDto[],
  reclaimEnabled: boolean,
): readonly ReclaimProjectStatusDto[] {
  if (!reclaimEnabled) {
    return [];
  }
  return reclaimProjects.filter(
    (project) => project.reclaimedCountUnknown || project.lastError !== null,
  );
}

export function formatReclaimProjectLine(status: ReclaimProjectStatusDto): string {
  const parts: string[] = [];
  if (status.lastRunAt !== null) {
    parts.push(`最終実行 ${formatActivityTime(new Date(status.lastRunAt))}`);
  } else {
    parts.push('未実行');
  }
  if (status.reclaimedCountUnknown) {
    parts.push('回収件数不明');
  } else if (status.reclaimedCount !== null) {
    parts.push(`回収 ${status.reclaimedCount}件`);
  }
  return parts.join(' / ');
}
