import type { CommandRunner } from '../../application/ports/command-runner.js';
import { bdVersionSchema } from './bd-issue-schema.js';
import { runBdCommandForStdout } from './bd-cli-tool-runner.js';

/**
 * `bd version --json` から CLI 自身が報告するバージョンを読む。
 * この確認は診断用なので、コマンド・JSON・schema のいずれの失敗も null に落として起動を妨げない。
 */
export async function readBdVersion(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
): Promise<string | null> {
  try {
    const stdout = await runBdCommandForStdout(
      commandRunner,
      bdPath,
      timeoutMs,
      rootPath,
      ['version', '--json'],
      'bd version',
    );
    const parsed = bdVersionSchema.safeParse(JSON.parse(stdout) as unknown);
    const version = parsed.success ? parsed.data.version.trim() : '';

    return version === '' ? null : version;
  } catch {
    return null;
  }
}
