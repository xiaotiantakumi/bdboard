// bdboard-sso1.84: bd-cli-human-decisions.test.ts (1935 行) を関心別ファイルへ move-only
// で分割した際、複数のテストファイルから使う createFakeRunner だけをここへ出した。
// 1ファイルでしか使わないヘルパー (expectedXArgs / isHumanListCall / showGateHandler 等) は
// それぞれの消費先ファイルにそのまま残している。関数本体・型は分割前から1文字も変えていない。
import type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
} from '../../application/ports/command-runner.js';

export interface FakeRunnerOptions {
  readonly handler?: (
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ) => Promise<CommandResult> | CommandResult;
}

export function createFakeRunner(options: FakeRunnerOptions = {}): {
  runner: CommandRunner;
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options?: CommandRunOptions;
  }>;
} {
  const calls: Array<{
    command: string;
    args: readonly string[];
    options?: CommandRunOptions;
  }> = [];

  const runner: CommandRunner = {
    async run(command, args, runOptions) {
      calls.push({ command, args, options: runOptions });
      if (options.handler) {
        return await options.handler(command, args, runOptions);
      }
      return { stdout: '[]', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}
