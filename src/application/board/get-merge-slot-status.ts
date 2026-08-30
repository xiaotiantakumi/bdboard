import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import {
  evaluateMergeSlotStatus,
  type MergeSlotStatus,
  type MergeSlotThresholds,
} from '../../domain/merge-slot.js';
import { runWithConcurrencyLimit } from '../concurrency.js';
import type { MergeSlotReader } from '../ports/merge-slot-reader.js';
import { describeFetchFailures, type FetchFailure } from './fetch-failure-log.js';

const PROJECT_SCAN_CONCURRENCY = 3;

export interface GetMergeSlotStatusOptions {
  readonly projectIds?: readonly string[];
  readonly thresholds?: MergeSlotThresholds;
  /** 取得失敗の警告ログ。未指定なら console.warn (discover-projects と同じ注入流儀)。 */
  readonly logWarn?: (message: string) => void;
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
  const failures: FetchFailure[] = [];

  await runWithConcurrencyLimit(targetProjects, PROJECT_SCAN_CONCURRENCY, async (project) => {
    try {
      const signal = await reader.readMergeSlotSignal(project.rootPath);
      statuses.push(
        evaluateMergeSlotStatus(project.id, signal, now, options?.thresholds),
      );
    } catch (error) {
      failures.push({ id: project.id, error });
    }
  });

  if (failures.length > 0) {
    const logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
    logWarn(
      '[hygiene] could not read merge slot status for some projects; they are missing from the panel. ' +
        describeFetchFailures(failures, targetProjects.length),
    );
  }

  statuses.sort((a, b) => compareStrings(a.projectId, b.projectId));

  return statuses;
}
