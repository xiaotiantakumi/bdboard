import type { Project } from '../../domain/project.js';
import {
  evaluateMergeSlotStatus,
  type MergeSlotStatus,
  type MergeSlotThresholds,
} from '../../domain/merge-slot.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { MergeSlotReader } from '../ports/merge-slot-reader.js';

const PROJECT_SCAN_CONCURRENCY = 3;

export interface GetMergeSlotStatusOptions {
  readonly projectIds?: readonly string[];
  readonly thresholds?: MergeSlotThresholds;
}

export async function getMergeSlotStatus(
  projects: readonly Project[],
  reader: MergeSlotReader,
  now: Date,
  options?: GetMergeSlotStatusOptions,
): Promise<readonly MergeSlotStatus[]> {
  let targetProjects = projects;
  if (options?.projectIds !== undefined) {
    const filterSet = new Set(options.projectIds);
    targetProjects = projects.filter((project) => filterSet.has(project.id));
  }

  const statuses: MergeSlotStatus[] = [];

  await runWithConcurrencyLimit(targetProjects, PROJECT_SCAN_CONCURRENCY, async (project) => {
    try {
      const signal = await reader.readMergeSlotSignal(project.rootPath);
      statuses.push(
        evaluateMergeSlotStatus(project.id, signal, now, options?.thresholds),
      );
    } catch {
      // Skip projects whose reader rejects without failing the whole call.
    }
  });

  statuses.sort((a, b) => a.projectId.localeCompare(b.projectId));

  return statuses;
}
