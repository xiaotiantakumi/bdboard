import type { GitWorktreeSnapshot } from '../../../domain/git-worktree.js';
import type { ScannerDeps } from './deps.js';
import { runGit } from './git-command.js';
import { parseBdBranches, parseWorktreePorcelain } from './scan-parsing.js';

export async function scanWorktrees(
  deps: ScannerDeps,
  rootPath: string,
): Promise<GitWorktreeSnapshot> {
  const { commandRunner, gitPath, timeoutMs } = deps;
  const [worktreeResult, branchResult] = await Promise.all([
    runGit(commandRunner, gitPath, rootPath, ['worktree', 'list', '--porcelain'], timeoutMs),
    runGit(
      commandRunner,
      gitPath,
      rootPath,
      ['branch', '--list', 'bd/*', '--format=%(refname:short)'],
      timeoutMs,
    ),
  ]);

  const worktreeOk = worktreeResult.exitCode === 0 && worktreeResult.failureKind === undefined;
  const branchOk = branchResult.exitCode === 0 && branchResult.failureKind === undefined;

  const worktrees = worktreeOk ? parseWorktreePorcelain(worktreeResult.stdout) : [];
  const bdBranches = branchOk ? parseBdBranches(branchResult.stdout) : [];

  // CommandRunner は spawn 失敗も timeout も throw せず resolve するので、
  // ここで落とすと「git が動かなかった」が「残骸ゼロ」と区別できなくなる。
  return { worktrees, bdBranches, complete: worktreeOk && branchOk };
}
