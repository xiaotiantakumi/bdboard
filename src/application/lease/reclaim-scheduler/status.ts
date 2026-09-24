import type { MutableProjectStatus, ReclaimProjectStatus } from './types.js';

export function ensureProjectStatus(
  statusByProjectId: Map<string, MutableProjectStatus>,
  projectId: string,
): MutableProjectStatus {
  let entry = statusByProjectId.get(projectId);
  if (entry === undefined) {
    entry = {
      projectId,
      lastRunAt: null,
      reclaimedCount: null,
      reclaimedCountUnknown: false,
      rawSummary: null,
      lastError: null,
    };
    statusByProjectId.set(projectId, entry);
  }
  return entry;
}

export function toProjectStatusSnapshot(entry: MutableProjectStatus): ReclaimProjectStatus {
  return {
    projectId: entry.projectId,
    lastRunAt: entry.lastRunAt?.toISOString() ?? null,
    reclaimedCount: entry.reclaimedCount,
    reclaimedCountUnknown: entry.reclaimedCountUnknown,
    rawSummary: entry.rawSummary,
    lastError: entry.lastError,
  };
}
