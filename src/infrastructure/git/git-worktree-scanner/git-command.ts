import type { CommandResult, CommandRunner } from '../../../application/ports/command-runner.js';

export async function runGit(
  commandRunner: CommandRunner,
  gitPath: string,
  rootPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return commandRunner.run(gitPath, ['-C', rootPath, ...args], { timeoutMs });
}

/**
 * `--no-optional-locks` 付きで git を読む。listChangedFiles 専用。
 *
 * 理由が 2 つある。
 *
 * 1. **他セッションの worktree に index.lock を取らない。** 通常の `git status` /
 *    `git diff` は stat キャッシュを更新して index を書き戻すため、盤面を開くたびに
 *    「別のエージェントが作業中の worktree」でロックを取りに行くことになる。読むだけの
 *    約束を、実装レベルでも守る。
 * 2. **速い。** index の書き戻し自体が盤面更新のたびに全 worktree ぶん走ると
 *    無視できない (実測で /api/hygiene が +2.5 秒)。
 *
 * 代償として index の mtime が「作業ツリーが変わった印」にならなくなるので、
 * キャッシュのキーには使えない (CommittedFilesCacheEntry のコメント参照)。
 */
export async function runGitReadOnly(
  commandRunner: CommandRunner,
  gitPath: string,
  rootPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return commandRunner.run(gitPath, ['--no-optional-locks', '-C', rootPath, ...args], {
    timeoutMs,
  });
}
