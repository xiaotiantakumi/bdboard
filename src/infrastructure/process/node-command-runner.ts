import { spawn, type ChildProcess } from 'node:child_process';
import type {
  CommandFailureKind,
  CommandResult,
  CommandRunOptions,
  CommandRunner,
} from '../../application/ports/command-runner.js';
import { killProcessTree } from './kill-process-tree.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 32 * 1024 * 1024;

function appendChunk(chunks: Buffer[], size: number, text: string): number {
  if (size >= MAX_BUFFER) {
    return size;
  }

  const chunk = Buffer.from(text, 'utf8');
  const remaining = MAX_BUFFER - size;
  chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
  return size + Math.min(chunk.length, remaining);
}

function resultFrom(
  stdoutChunks: Buffer[],
  stderrChunks: Buffer[],
  exitCode: number,
  failureKind?: CommandFailureKind,
): CommandResult {
  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    exitCode,
    ...(failureKind === undefined ? {} : { failureKind }),
  };
}

export class NodeCommandRunner implements CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult> {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options?.cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(options?.env !== undefined ? { env: { ...options.env } } : {}),
      });
    } catch {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: -1,
        failureKind: 'spawn-failed',
      });
    }

    return new Promise<CommandResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let failureKind: CommandFailureKind | undefined;
      let settled = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

      const clearTimeoutTimer = (): void => {
        if (timeoutTimer !== undefined) {
          clearTimeout(timeoutTimer);
        }
      };

      const finish = (exitCode: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeoutTimer();
        resolve(resultFrom(stdoutChunks, stderrChunks, exitCode, failureKind));
      };

      const onData = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (stream === 'stdout') {
          stdoutSize = appendChunk(stdoutChunks, stdoutSize, text);
        } else {
          stderrSize = appendChunk(stderrChunks, stderrSize, text);
        }
      };

      child.stdout?.on('data', (chunk: Buffer | string) => onData('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer | string) => onData('stderr', chunk));

      child.on('error', () => {
        if (failureKind === undefined) {
          failureKind = 'spawn-failed';
        }
        finish(-1);
      });
      child.on('close', (code) => {
        finish(code ?? -1);
      });

      if (child.stdin !== null && options?.input !== undefined) {
        // The child may exit before draining stdin. Ignore EPIPE so it cannot
        // become an uncaught exception in the server process.
        child.stdin.on('error', () => {});
        child.stdin.end(options.input);
      }

      timeoutTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        if (failureKind === undefined) {
          failureKind = 'timeout';
        }
        killProcessTree(child, 'SIGTERM');
      }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
  }
}
