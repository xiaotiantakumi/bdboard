import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CommandFailureKind,
  CommandResult,
  CommandRunOptions,
  CommandRunner,
} from '../../application/ports/command-runner.js';

type ExecFilePromise = Promise<{ stdout: string; stderr: string }> & {
  child: ChildProcess;
};

const execFileAsync = promisify(execFile) as (
  command: string,
  args: string[],
  options: object,
) => ExecFilePromise;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 32 * 1024 * 1024;

interface ExecFileError extends Error {
  code?: number | string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  killed?: boolean;
  signal?: string;
}

function toString(value: string | Buffer | undefined): string {
  if (value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : value.toString('utf8');
}

export class NodeCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult> {
    try {
      const execOptions = {
        cwd: options?.cwd,
        timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8' as const,
        ...(options?.env !== undefined ? { env: { ...options.env } } : {}),
      };

      const promise = execFileAsync(command, [...args], execOptions);

      if (options?.input !== undefined) {
        const stdin = promise.child.stdin;
        if (stdin !== null && stdin !== undefined) {
          // The child may exit before draining stdin (bad args, early exit).
          // Without this handler the resulting EPIPE is an uncaught exception
          // that would take down the whole server process.
          stdin.on('error', () => {});
          stdin.end(options.input);
        }
      }

      const { stdout, stderr } = await promise;

      return {
        stdout: toString(stdout),
        stderr: toString(stderr),
        exitCode: 0,
      };
    } catch (error: unknown) {
      const execError = error as ExecFileError;
      const exitCode = typeof execError.code === 'number' ? execError.code : -1;

      // timeout オプションを常に渡しているため、 killed === true はほぼ確実にタイムアウト。
      let failureKind: CommandFailureKind | undefined;
      if (execError.killed === true) {
        failureKind = 'timeout';
      } else if (typeof execError.code === 'string') {
        failureKind = 'spawn-failed';
      }

      return {
        stdout: toString(execError.stdout),
        stderr: toString(execError.stderr),
        exitCode,
        ...(failureKind !== undefined ? { failureKind } : {}),
      };
    }
  }
}
