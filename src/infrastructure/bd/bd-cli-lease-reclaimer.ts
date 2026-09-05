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
  ticketIds: readonly string[],
): readonly string[] {
  // 空配列は `--id` を1つも付けない = 全件対象、という真逆の意味になる。型では
  // 塞いであるが、テストの `as unknown as` や JS からの呼び出しは型を素通りするので
  // ここで落とす。**黙って最も広いコマンドを組み立てないこと**が要点。
  if (ticketIds.length === 0) {
    throw new Error(
      'buildReclaimArgs: empty ticketIds would reclaim the whole project; ' +
        'callers must skip the bd invocation instead',
    );
  }
  // NOTE: `--no-pager` is valid on `bd list` but `bd reclaim` rejects it
  // (Error: unknown flag) — do not add it here.
  const args = ['-C', rootPath, 'reclaim', '--older-than', olderThan];
  for (const ticketId of ticketIds) {
    args.push('--id', ticketId);
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
