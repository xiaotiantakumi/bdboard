import type { PackDefinition, PackSummary } from '../../domain/harness-pack.js';

export interface PackRegistryPort {
  listPacks(): Promise<readonly PackSummary[]>;
  getPack(name: string): Promise<PackDefinition | undefined>;
}
