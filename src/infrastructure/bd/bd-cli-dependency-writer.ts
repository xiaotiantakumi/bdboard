import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { DependencyWriterPort } from '../../application/ports/dependency-writer.js';
import { runBdTool } from './bd-cli-tool-runner.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BdCliDependencyWriterOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

export function createBdCliDependencyWriter(
  commandRunner: CommandRunner,
  options?: BdCliDependencyWriterOptions,
): DependencyWriterPort {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async addDependency(
      rootPath: string,
      issueId: string,
      dependsOnId: string,
    ): Promise<void> {
      await runBdTool(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        'bd_dep_add',
        { id: issueId, dependsOnId },
        issueId,
      );
    },

    async removeDependency(
      rootPath: string,
      issueId: string,
      dependsOnId: string,
    ): Promise<void> {
      await runBdTool(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        'bd_dep_remove',
        { id: issueId, dependsOnId },
        issueId,
      );
    },
  };
}
