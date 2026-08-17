import type { Project } from '../../domain/project.js';
import {
  evaluateSyncHealth,
  type SyncHealth,
  type SyncHealthThresholds,
} from '../../domain/sync-health.js';
import type { SyncHealthReader } from '../ports/sync-health-reader.js';

export interface GetSyncHealthOptions {
  readonly thresholds?: SyncHealthThresholds;
}

export async function getSyncHealth(
  projects: readonly Project[],
  reader: SyncHealthReader,
  options?: GetSyncHealthOptions,
): Promise<readonly SyncHealth[]> {
  const settled = await Promise.allSettled(
    projects.map(async (project) =>
      evaluateSyncHealth(
        project.id,
        await reader.readSignals(project.rootPath),
        options?.thresholds,
      ),
    ),
  );

  const result: SyncHealth[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      result.push(outcome.value);
    }
  }

  return result;
}
