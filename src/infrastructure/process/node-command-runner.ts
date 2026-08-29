import { spawn, type ChildProcess } from 'node:child_process';
import type {
  CommandFailureKind,
  CommandResult,
  CommandRunOptions,
  CommandRunner,
} from '../../application/ports/command-runner.js';
import { killProcessTree } from './kill-process-tree.js';

const DEFAULT_TIMEOUT_MS = 10_000;
/** SIGTERM を送ってから SIGKILL へ上げるまでの猶予 (streaming 側と揃える)。 */
const STOP_GRACE_MS = 3_000;
/** 'exit' を見てから 'close' を待つ時間。これを過ぎたら自前でパイプを破棄する。 */
const EXIT_BACKSTOP_MS = 300;
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
      let stopping = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;

      const clearTimers = (): void => {
        if (timeoutTimer !== undefined) {
          clearTimeout(timeoutTimer);
        }
        if (stopTimer !== undefined) {
          clearTimeout(stopTimer);
        }
      };

      const finish = (exitCode: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        resolve(resultFrom(stdoutChunks, stderrChunks, exitCode, failureKind));
      };

      const destroyStdio = (): void => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      };

      // bdboard-3x5: 孫プロセスが stdout/stderr のパイプ fd を継承していると、
      // 直接の子を殺しても OS のパイプは開いたままになり得て 'close' が永久に
      // 来ない (= この Promise が settle せず、呼び出し元がサーバー再起動まで
      // 固まる)。SIGKILL の前に Node 側のストリームを明示的に破棄しておくことで、
      // 他プロセスが fd を握っていても ChildProcess 自身の 'close' 判定は満たされる。
      // streaming 側 (bdboard-l1t.9 Opus レビュー M1) と同じ手当て。
      const forceStop = (): void => {
        if (settled) {
          return;
        }
        destroyStdio();
        if (!killProcessTree(child, 'SIGKILL')) {
          return;
        }
        stopTimer = undefined;
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
      // bdboard-3x5 バックストップ: 通常終了・SIGKILL のどちらでも、孫プロセスが
      // stdio パイプを保持していると上の 'close' が来ないことがある。'exit'
      // (プロセス自体の終了) は孫の有無に関わらず必ず来るので、それを見て一定時間
      // 内に 'close' が来なければ自前でパイプを破棄して settle する。これが無いと、
      // 正常終了 (exitCode 0) がパイプ遅延の間にタイムアウトへ巻き込まれ、
      // failureKind:'timeout' と誤ラベルされる — reclaim-scheduler は failureKind の
      // 有無で失敗判定するため、成功した操作が失敗として扱われる。
      child.on('exit', (code) => {
        setTimeout(() => {
          if (settled) {
            return;
          }
          destroyStdio();
          finish(code ?? -1);
        }, EXIT_BACKSTOP_MS).unref?.();
      });

      if (child.stdin !== null && options?.input !== undefined) {
        // The child may exit before draining stdin. Ignore EPIPE so it cannot
        // become an uncaught exception in the server process.
        child.stdin.on('error', () => {});
        child.stdin.end(options.input);
      }

      timeoutTimer = setTimeout(() => {
        if (settled || stopping) {
          return;
        }
        stopping = true;
        if (failureKind === undefined) {
          failureKind = 'timeout';
        }
        // SIGTERM を無視する子に当たると、これ一発では 'close' が永久に来ない。
        // 猶予後に SIGKILL へ上げる (bdboard-3x5)。
        if (!killProcessTree(child, 'SIGTERM')) {
          return;
        }
        stopTimer = setTimeout(forceStop, STOP_GRACE_MS);
      }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
  }
}
