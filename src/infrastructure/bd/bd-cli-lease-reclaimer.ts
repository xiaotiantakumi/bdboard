import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { LeaseReclaimer } from '../../application/ports/lease-reclaimer.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BdCliLeaseReclaimerOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

function buildReclaimArgs(rootPath: string, olderThan: string): readonly string[] {
  // NOTE: `--no-pager` is valid on `bd list` but `bd reclaim` rejects it
  // (Error: unknown flag) — do not add it here.
  return ['-C', rootPath, 'reclaim', '--older-than', olderThan];
}

export function createBdCliLeaseReclaimer(
  commandRunner: CommandRunner,
  options?: BdCliLeaseReclaimerOptions,
): LeaseReclaimer {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async reclaim(projectRootPath, olderThan) {
      const result = await commandRunner.run(
        bdPath,
        buildReclaimArgs(projectRootPath, olderThan),
        { timeoutMs },
      );

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.failureKind !== undefined ? { failureKind: result.failureKind } : {}),
      };
    },
  };
}
