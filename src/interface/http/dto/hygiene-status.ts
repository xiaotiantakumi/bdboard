// bdboard-sso1.12: dto.ts のモジュール分割。Hygiene パネルが表示する運用状態
// (stale lease・回収スケジューラ・merge-slot・PR バッジ) の DTO。
// lease-health-routes.ts / merge-slot-status-routes.ts / pr-links-routes.ts が
// 参照する (barrel 経由。bdboard-sso1.61 で hygiene-routes.ts から分割)。
// 検出された問題そのものは hygiene.ts 側。
import type { StaleLeaseIssue } from '../../../domain/lease.js';
import type { MergeSlotStatus } from '../../../domain/merge-slot.js';
import type { PrBadge } from '../../../domain/pr-link.js';
import type {
  ReclaimSchedulerStatus,
  ReclaimProjectStatus,
} from '../../../application/lease/reclaim-scheduler.js';

export interface StaleLeaseDto {
  ticketId: string;
  projectId: string;
  leaseExpiresAt: string;
  staleForMs: number;
}

export interface MergeSlotStatusDto {
  projectId: string;
  present: boolean;
  held: boolean;
  holder: string | null;
  heldSinceIso: string | null;
  heldForMs: number;
  isLongHeld: boolean;
}

export interface PrBadgeDto {
  ticketId: string;
  projectId: string;
  url: string;
  state: string | null;
  checkStatus: string | null;
}

export interface ReclaimProjectStatusDto {
  projectId: string;
  lastRunAt: string | null;
  reclaimedCount: number | null;
  reclaimedCountUnknown: boolean;
  rawSummary: string | null;
  lastError: string | null;
}

export interface ReclaimSchedulerStatusDto {
  enabled: boolean;
  intervalMs: number;
  olderThan: string;
  projects: ReclaimProjectStatusDto[];
}

export interface LeaseHealthDto {
  staleLeases: StaleLeaseDto[];
  reclaim: ReclaimSchedulerStatusDto;
}

export function toStaleLeaseDto(issue: StaleLeaseIssue): StaleLeaseDto {
  return {
    ticketId: issue.ticketId,
    projectId: issue.projectId,
    leaseExpiresAt: issue.leaseExpiresAt,
    staleForMs: issue.staleForMs,
  };
}

export function toMergeSlotStatusDto(status: MergeSlotStatus): MergeSlotStatusDto {
  return {
    projectId: status.projectId,
    present: status.present,
    held: status.held,
    holder: status.holder,
    heldSinceIso: status.heldSinceIso,
    heldForMs: status.heldForMs,
    isLongHeld: status.isLongHeld,
  };
}

export function toPrBadgeDto(badge: PrBadge): PrBadgeDto {
  return {
    ticketId: badge.ticketId,
    projectId: badge.projectId,
    url: badge.url,
    state: badge.status?.state ?? null,
    checkStatus: badge.status?.checkStatus ?? null,
  };
}

export function toReclaimProjectStatusDto(
  status: ReclaimProjectStatus,
): ReclaimProjectStatusDto {
  return {
    projectId: status.projectId,
    lastRunAt: status.lastRunAt,
    reclaimedCount: status.reclaimedCount,
    reclaimedCountUnknown: status.reclaimedCountUnknown,
    rawSummary: status.rawSummary,
    lastError: status.lastError,
  };
}

export function toReclaimSchedulerStatusDto(
  status: ReclaimSchedulerStatus,
): ReclaimSchedulerStatusDto {
  return {
    enabled: status.enabled,
    intervalMs: status.intervalMs,
    olderThan: status.olderThan,
    projects: status.projects.map(toReclaimProjectStatusDto),
  };
}

export function toLeaseHealthDto(input: {
  readonly staleLeases: readonly StaleLeaseIssue[];
  readonly reclaim: ReclaimSchedulerStatus;
}): LeaseHealthDto {
  return {
    staleLeases: input.staleLeases.map(toStaleLeaseDto),
    reclaim: toReclaimSchedulerStatusDto(input.reclaim),
  };
}
