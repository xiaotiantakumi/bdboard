import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type {
  StreamingCommandChunk,
  StreamingCommandResult,
  StreamingCommandRunOptions,
  StreamingCommandRunner,
  StreamingCommandFailureKind,
} from '../../application/ports/streaming-command-runner.js';
import { killProcessTree } from './kill-process-tree.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 3_000;
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
  failureKind?: StreamingCommandFailureKind,
): StreamingCommandResult {
  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    exitCode,
    ...(failureKind === undefined ? {} : { failureKind }),
  };
}

export class NodeStreamingCommandRunner implements StreamingCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: StreamingCommandRunOptions,
  ): Promise<StreamingCommandResult> {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(options.env !== undefined ? { env: { ...options.env } } : {}),
      });
    } catch {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: -1,
        failureKind: 'spawn-failed',
      });
    }

    return new Promise<StreamingCommandResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let failureKind: StreamingCommandFailureKind | undefined;
      let settled = false;
      let stopping = false;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

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
        options.signal?.removeEventListener('abort', onAbort);
        resolve(resultFrom(stdoutChunks, stderrChunks, exitCode, failureKind));
      };

      const destroyStdio = (): void => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      };

      const forceStop = (): void => {
        if (settled) {
          return;
        }
        // bdboard-l1t.9 Opus レビュー M1: 孫プロセスが stdout/stderr のパイプ fd を
        // 継承していると、直接の子を殺しても OS パイプは開いたままになり得て
        // 'close' イベントが永久に来ない(=このPromiseが settle しない → busy lock が
        // サーバー再起動まで解放されない)。SIGKILL の前に Node 側のパイプストリームを
        // 明示的に破棄しておくことで、他プロセスが fd を保持していても
        // ChildProcess 自身の 'close' 判定(このプロセスの stdio が閉じたか)は
        // 満たされるようにする。
        destroyStdio();
        if (!killProcessTree(child, 'SIGKILL')) {
          return;
        }
        stopTimer = undefined;
      };

      const stop = (kind: 'timeout' | 'aborted'): void => {
        if (settled || stopping) {
          return;
        }
        stopping = true;
        failureKind = kind;
        if (!killProcessTree(child, 'SIGTERM')) {
          return;
        }
        stopTimer = setTimeout(forceStop, STOP_GRACE_MS);
      };

      const stopForBufferLimit = (): void => {
        if (settled || stopping) {
          return;
        }
        stopping = true;
        failureKind = 'buffer-limit-exceeded';
        if (killProcessTree(child, 'SIGTERM')) {
          stopTimer = setTimeout(forceStop, STOP_GRACE_MS);
        }
      };

      const onAbort = (): void => {
        stop('aborted');
      };

      const onData = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const data: StreamingCommandChunk = { stream, text };
        options.onChunk(data);

        if (stream === 'stdout') {
          stdoutSize = appendChunk(stdoutChunks, stdoutSize, text);
          if (stdoutSize >= MAX_BUFFER) {
            stopForBufferLimit();
          }
        } else {
          stderrSize = appendChunk(stderrChunks, stderrSize, text);
          if (stderrSize >= MAX_BUFFER) {
            stopForBufferLimit();
          }
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
      // bdboard-l1t.9 Opus レビュー M1 バックストップ: 通常終了・SIGKILL のどちらでも、
      // 孫プロセスが stdio パイプを保持していると上の 'close' が来ないことがある。
      // 'exit'(プロセス自体の終了)は孫プロセスの有無に関わらず必ず来るので、
      // それを見て一定時間内に 'close' が来なければ自前でパイプを破棄して settle する。
      // bdboard-l1t.9 delta 再レビュー nit: 50ms だとイベントループが一瞬でも
      // 詰まっている環境で、まだ読み切れていないパイプ上のデータを取りこぼして
      // 早期破棄してしまうリスクがある。300ms に緩めて defense-in-depth を優先する
      // (M1 の本筋は「settle しないまま無限に待つ」ことの回避であり、数百ms早いか
      // 遅いかは実害が無い)。
      child.on('exit', (code) => {
        setTimeout(() => {
          if (settled) {
            return;
          }
          destroyStdio();
          finish(code ?? -1);
        }, 300).unref?.();
      });

      if (child.stdin !== null && options.input !== undefined) {
        // The child may exit before draining stdin. Ignore EPIPE so it cannot
        // become an uncaught exception in the server process.
        child.stdin.on('error', () => {});
        child.stdin.end(options.input);
      }

      if (options.signal !== undefined) {
        options.signal.addEventListener('abort', onAbort, { once: true });
        if (options.signal.aborted) {
          onAbort();
        }
      }

      timeoutTimer = setTimeout(
        () => stop('timeout'),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    });
  }
}
