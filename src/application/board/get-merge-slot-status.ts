import type { Project } from '../../domain/project.js';
import {
  evaluateMergeSlotStatus,
  type MergeSlotStatus,
  type MergeSlotThresholds,
} from '../../domain/merge-slot.js';
import type { MergeSlotReader } from '../ports/merge-slot-reader.js';

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

  const settled = await Promise.allSettled(
    targetProjects.map(async (project) => {
      const signal = await reader.readMergeSlotSignal(project.rootPath);
      return evaluateMergeSlotStatus(
        project.id,
        signal,
        now,
        options?.thresholds,
      );
    }),
  );

  const statuses: MergeSlotStatus[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      statuses.push(outcome.value);
    }
  }

  statuses.sort((a, b) => a.projectId.localeCompare(b.projectId));

  return statuses;
}
