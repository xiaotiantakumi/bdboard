import type { ProjectHarnessStatus } from '../../domain/harness-pack.js';
import type { Project } from '../../domain/project.js';
import type { HarnessContractReaderPort } from '../ports/harness-contract-reader.js';
import type { HarnessInjectorPort } from '../ports/harness-injector.js';
import type { PackRegistryPort } from '../ports/pack-registry.js';
import {
  computeProjectHarnessStatus,
  resolveProjectContractState,
} from './get-project-harness-status.js';

export interface ProjectHarnessStatusEntry {
  readonly projectId: string;
  readonly status: ProjectHarnessStatus;
}

export interface GetAllProjectsHarnessStatusInput {
  readonly registry: PackRegistryPort;
  readonly injector: HarnessInjectorPort;
  readonly contractReader: HarnessContractReaderPort;
  readonly projects: readonly Project[];
}

export async function getAllProjectsHarnessStatus(
  input: GetAllProjectsHarnessStatusInput,
): Promise<readonly ProjectHarnessStatusEntry[]> {
  const availablePacks = await input.registry.listPacks();

  return Promise.all(
    input.projects.map(async (project) => {
      const manifest = await input.injector.readManifest(project.rootPath);
      const [contract, settingsJson] = await Promise.all([
        resolveProjectContractState(input.contractReader, project.rootPath, manifest),
        input.injector.readSettings(project.rootPath),
      ]);
      return {
        projectId: project.id,
        status: computeProjectHarnessStatus(
          availablePacks,
          manifest,
          contract,
          settingsJson,
        ),
      };
    }),
  );
}
