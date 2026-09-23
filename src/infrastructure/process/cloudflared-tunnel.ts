// bdboard-sso1.54: src/infrastructure/process/cloudflared-tunnel.ts は
// bdboard-sso1.54 でモジュール分割された。実体は ./cloudflared-tunnel/ 配下:
//   - log-sink.ts          : ログパス解決 / 秘匿マスキング / ローテーション /
//     LogSink 実装 (resolveDefaultTunnelLogFilePath / LogSink / maskSecrets /
//     createNoopLogSink / createFileLogSink / DEFAULT_LOG_MAX_BYTES)
//   - spawned-process.ts   : ChildProcess を SpawnedProcess へ薄くラップするアダプタ
//     (DataStream / SpawnedProcess / SpawnFn / asSpawnedProcess)
//   - executable-resolver.ts: cloudflared 実行ファイルの PATH 探索
//     (resolveCloudflaredInPath)
//   - startup-buffer.ts    : 起動待ち中の stdout/stderr バッファ管理
//     (STARTUP_OUTPUT_BUFFER_MAX_BYTES / appendStartupOutputBuffer / extractTunnelUrl)
// このファイルは createCloudflaredTunnel() 本体(可変状態を共有するクロージャ群のため
// 分割せず残した)と、import 側(呼び出し元・テスト)を書き換えないための再エクスポートを
// 兼ねる。挙動・型は一切変えていない(移動のみ)。
import { spawn as nodeSpawn } from 'node:child_process';
import type {
  TunnelProcess,
  TunnelStartResult,
} from '../../application/ports/tunnel.js';
import {
  resolveDefaultTunnelLogFilePath,
  DEFAULT_LOG_MAX_BYTES,
  maskSecrets,
  createNoopLogSink,
  createFileLogSink,
  type LogSink,
} from './cloudflared-tunnel/log-sink.js';
import {
  asSpawnedProcess,
  type SpawnedProcess,
  type SpawnFn,
} from './cloudflared-tunnel/spawned-process.js';
import { resolveCloudflaredInPath } from './cloudflared-tunnel/executable-resolver.js';
import {
  appendStartupOutputBuffer,
  extractTunnelUrl,
} from './cloudflared-tunnel/startup-buffer.js';

export type { LogSink } from './cloudflared-tunnel/log-sink.js';
export { resolveDefaultTunnelLogFilePath } from './cloudflared-tunnel/log-sink.js';
export type {
  DataStream,
  SpawnedProcess,
  SpawnFn,
} from './cloudflared-tunnel/spawned-process.js';
export {
  STARTUP_OUTPUT_BUFFER_MAX_BYTES,
  appendStartupOutputBuffer,
} from './cloudflared-tunnel/startup-buffer.js';

const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5_000;

export interface CloudflaredTunnelOptions {
  readonly port: number;
  readonly spawnFn?: SpawnFn;
  readonly startTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly pathEnv?: string;
  readonly resolveExecutable?: () => string | null;
  /** cloudflared の継続的な出力ログの保存先
   *  (既定: resolveDefaultTunnelLogFilePath() = ~/.bdboard/logs/cloudflared-tunnel.log) */
  readonly logFilePath?: string;
  /** ログファイルのサイズ上限(バイト、既定: 5MB)。超過時は起動時に .log.1 へ退避する */
  readonly logMaxBytes?: number;
  /** テスト用にログ書き込み先を差し替えるフック */
  readonly createLogSink?: (filePath: string, maxBytes: number) => LogSink;
}

export function createCloudflaredTunnel(
  options: CloudflaredTunnelOptions,
): TunnelProcess {
  const spawnFn =
    options.spawnFn ??
    ((cmd, args): SpawnedProcess =>
      asSpawnedProcess(
        nodeSpawn(cmd, [...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ));
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const resolveExecutable =
    options.resolveExecutable ?? ((): string | null => resolveCloudflaredInPath(pathEnv, options));
  const logFilePath = options.logFilePath ?? resolveDefaultTunnelLogFilePath();
  const logMaxBytes = options.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const createLogSink = options.createLogSink ?? createFileLogSink;

  let child: SpawnedProcess | null = null;
  let outputBuffer = '';
  const unexpectedExitListeners: Array<() => void> = [];

  const onUnexpectedExit = (listener: () => void): void => {
    unexpectedExitListeners.push(listener);
  };

  const notifyUnexpectedExit = (): void => {
    for (const listener of unexpectedExitListeners) {
      listener();
    }
  };

  // キャッシュは持たない。ここは「今 PATH に cloudflared があるか」を素直に答える。
  // 以前は結果を恒久キャッシュしていたが、「見つからない」は brew install 一つで
  // 覆るので、固定するとサーバー再起動まで拾えなかった (bdboard-syr)。
  // キャッシュの責務は呼び出し元の tunnel-service に一元化してある (TTL 付き) —
  // ここにも置くと、二層のどちらが効いているのか追えなくなる。
  // 走査自体は PATH 46 エントリで実測 0.14ms 未満なので、素通しで問題ない。
  const isAvailable = async (): Promise<boolean> => resolveExecutable() !== null;

  const stop = async (): Promise<void> => {
    const current = child;
    if (current === null) {
      return;
    }

    child = null;
    outputBuffer = '';

    if (!current.kill('SIGTERM')) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(forceKillTimer);
        resolve();
      };

      const forceKillTimer = setTimeout(() => {
        current.kill('SIGKILL');
        finish();
      }, stopGraceMs);

      current.on('close', () => {
        finish();
      });

      current.on('error', () => {
        finish();
      });
    });
  };

  const stopExistingSynchronously = (): void => {
    const current = child;
    if (current === null) {
      return;
    }

    child = null;
    outputBuffer = '';
    current.kill('SIGTERM');
  };

  const start = (): Promise<TunnelStartResult> => {
    const executable = resolveExecutable();
    if (executable === null) {
      return Promise.reject(
        new Error('cloudflared executable not found in PATH'),
      );
    }

    stopExistingSynchronously();

    outputBuffer = '';
    const processHandle = spawnFn(executable, [
      'tunnel',
      '--url',
      `http://127.0.0.1:${options.port}`,
    ]);
    child = processHandle;

    // シンクの生成失敗でトンネル起動を巻き込まない (bdboard-nte)。
    // 出力先が通常ファイルとして存在する・権限が無い・read-only FS といった
    // ケースで createFileLogSink の mkdirSync/openSync は throw する。書き込み
    // 失敗自体は既に「トンネル動作を阻害しない」設計 (createFileLogSink の
    // write/close、rotateLogFileIfOversized) なので、生成だけがその方針から
    // 外れているのは一貫していない。
    //
    // なお、シンクを spawn より前に作る順序も検討したが採らなかった。先に
    // 作ると spawnFn が throw した場合に開いた fd が閉じられずに漏れる。
    // 「生成失敗を握り潰す」だけで目的は足りている。
    let logSink: LogSink;
    try {
      logSink = createLogSink(logFilePath, logMaxBytes);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `cloudflared log sink unavailable (${logFilePath}): ${detail}. Continuing without a tunnel log.`,
      );
      logSink = createNoopLogSink();
    }
    logSink.write(`\n[${new Date().toISOString()}] cloudflared starting (port ${options.port})\n`);

    return new Promise<TunnelStartResult>((resolve, reject) => {
      let settled = false;

      const fail = (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutTimer);
        void stop().finally(() => {
          reject(err);
        });
      };

      const succeed = (url: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutTimer);
        resolve({ url });
      };

      const onData = (chunk: Buffer | string): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        logSink.write(maskSecrets(text));

        if (settled) {
          return;
        }

        outputBuffer = appendStartupOutputBuffer(outputBuffer, chunk);
        const url = extractTunnelUrl(outputBuffer);
        if (url !== null) {
          outputBuffer = '';
          succeed(url);
        }
      };

      const timeoutTimer = setTimeout(() => {
        fail(new Error('timed out waiting for cloudflared tunnel URL'));
      }, startTimeoutMs);

      processHandle.stdout?.on('data', onData);
      processHandle.stderr?.on('data', onData);

      processHandle.on('error', (err) => {
        fail(err);
      });

      processHandle.on('close', (code) => {
        logSink.write(`[${new Date().toISOString()}] cloudflared exited (code=${String(code)})\n`);
        logSink.close();

        if (!settled) {
          fail(
            new Error(
              `cloudflared exited before publishing a URL (code=${String(code)})`,
            ),
          );
          return;
        }

        // 起動成功後の close: このハンドルがまだ「現在のトンネル」として追跡されている
        // (= 自分たちが stop() を呼んで child をクリアしていない)場合のみ、予期せぬ終了と
        // みなす。stop() は kill 前に child を null にするため、意図した停止ではここに
        // 入らない。
        if (child === processHandle) {
          child = null;
          outputBuffer = '';
          notifyUnexpectedExit();
        }
      });
    });
  };

  return {
    start,
    onUnexpectedExit,
    stop,
    isAvailable,
  };
}
