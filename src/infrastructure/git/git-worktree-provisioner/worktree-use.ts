import type { CommandRunner } from '../../../application/ports/command-runner.js';

export type WorktreeUseStatus = 'idle' | 'busy' | 'unknown';

export async function inspectWorktreeUse(
  commandRunner: CommandRunner,
  lsofPath: string,
  worktreePath: string,
  timeoutMs: number,
): Promise<WorktreeUseStatus> {
  const result = await commandRunner.run(
    lsofPath,
    ['-a', '-d', 'cwd', '+D', worktreePath],
    { timeoutMs },
  );

  // Some lsof builds return 1 even after printing matches. Output is the
  // authoritative signal: any listed process makes the worktree busy.
  if (result.stdout.trim() !== '') {
    return 'busy';
  }

  if (
    result.exitCode === 0
    && result.failureKind === undefined
    && result.stderr.trim() === ''
  ) {
    return 'idle';
  }

  // lsof uses exit 1 with no output when the selection matched no processes.
  // Spawn failures, timeouts, diagnostics, and every other non-zero result are
  // intentionally unknown so cleanup fails closed.
  if (
    result.exitCode === 1
    && result.failureKind === undefined
    && result.stderr.trim() === ''
  ) {
    return 'idle';
  }

  return 'unknown';
}
