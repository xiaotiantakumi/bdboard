import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { LeaseReclaimer } from '../../application/ports/lease-reclaimer.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BdCliLeaseReclaimerOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

export function buildReclaimArgs(
  rootPath: string,
  olderThan: string,
  ticketIds?: readonly string[],
): readonly string[] {
  // NOTE: `--no-pager` is valid on `bd list` but `bd reclaim` rejects it
  // (Error: unknown flag) — do not add it here.
  const args = ['-C', rootPath, 'reclaim', '--older-than', olderThan];
  // 空配列は `--id` を1つも付けない = 全件対象、という真逆の意味になる。
  // 呼び出し側 (reclaim-scheduler) は空なら bd を呼ばずに握り潰すが、
  // ここでも取り違えないよう長さで分岐しておく。
  if (ticketIds !== undefined && ticketIds.length > 0) {
    for (const ticketId of ticketIds) {
      args.push('--id', ticketId);
    }
  }
  return args;
}

export function createBdCliLeaseReclaimer(
  commandRunner: CommandRunner,
  options?: BdCliLeaseReclaimerOptions,
): LeaseReclaimer {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async reclaim(projectRootPath, olderThan, ticketIds) {
      const result = await commandRunner.run(
        bdPath,
        buildReclaimArgs(projectRootPath, olderThan, ticketIds),
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
