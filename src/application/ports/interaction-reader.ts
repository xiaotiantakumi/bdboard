import type { InteractionRecord } from '../../domain/interaction.js';
import type { Project } from '../../domain/project.js';

export interface InteractionReadInput {
  readonly projects: readonly Project[];
}

export interface InteractionReader {
  read(input: InteractionReadInput): Promise<readonly InteractionRecord[]>;
}
