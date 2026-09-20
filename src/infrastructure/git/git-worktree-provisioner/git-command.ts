import type { CommandResult, CommandRunner } from '../../../application/ports/command-runner.js';

export function runGit(
  commandRunner: CommandRunner,
  gitPath: string,
  rootPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return commandRunner.run(gitPath, ['-C', rootPath, ...args], { timeoutMs });
}
