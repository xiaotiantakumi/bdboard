import { compareStrings } from '../../domain/compare.js';
import type {
  HarnessManifest,
  PackSummary,
  ProjectHarnessStatus,
} from '../../domain/harness-pack.js';
import type { PackRegistryPort } from '../ports/pack-registry.js';

export function computeProjectHarnessStatus(
  availablePacks: readonly PackSummary[],
  manifest: HarnessManifest,
): ProjectHarnessStatus {
  const installedByName = new Map(manifest.packs.map((entry) => [entry.name, entry]));

  const packs = availablePacks
    .map((available) => {
      const installed = installedByName.get(available.name);
      const installedVersion = installed?.version ?? null;
      const drift =
        installedVersion !== null && installedVersion !== available.version;

      return {
        name: available.name,
        availableVersion: available.version,
        installedVersion,
        drift,
      };
    })
    .sort((a, b) => compareStrings(a.name, b.name));

  return { packs };
}

export async function getProjectHarnessStatus(
  registry: PackRegistryPort,
  manifest: HarnessManifest,
): Promise<ProjectHarnessStatus> {
  const availablePacks = await registry.listPacks();
  return computeProjectHarnessStatus(availablePacks, manifest);
}
