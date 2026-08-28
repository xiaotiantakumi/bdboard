import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  TunnelProcess,
  TunnelStartResult,
} from '../../application/ports/tunnel.js';

const TRY_CLOUDFLARE_URL_PATTERN =
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
/**
 * cloudflared のログ既定パスを解決する。
 *
 * 以前は `path.join(process.cwd(), 'logs', ...)` だった (bdboard-3b0)。配布形態
 * (`npx bdboard`) は任意の cwd から起動されるので、cwd 基準だとトンネルを開いた
 * 瞬間に「ユーザーがたまたま居たディレクトリ」へ `logs/` を掘ることになる。
 * ホームディレクトリだろうが他人のリポジトリのルートだろうが掘る。
 *
 * 置き場はキャッシュ DB (`~/.bdboard/cache.db`, src/main.ts) と同じ `~/.bdboard/`
 * に揃えた。設定ファイル (`~/.config/bdboard/config.json`, infrastructure/fs/
 * config-path.ts) の側ではない — ログは人が編集する設定ではなく実行時生成物
 * なので、既に実行時生成物が置かれている場所に寄せる方が一貫する。
 *
 * homedir を注入できるのはテスト用。os.homedir() は Windows でもユーザー
 * プロファイルを返すので、プラットフォーム分岐は要らない。
 */
export function resolveDefaultTunnelLogFilePath(opts?: {
  homedir?: string;
}): string {
  const home = opts?.homedir ?? os.homedir();
  return path.join(home, '.bdboard', 'logs', 'cloudflared-tunnel.log');
}
/** ログファイルの既定サイズ上限(5MB)。超過すると .log -> .log.1 へ退避される。 */
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

// cloudflared の標準出力に資格情報が乗ることは通常無いが、事後調査用ログとして残す以上、
// 万一それらしき文字列が混ざっていた場合の最終防衛として伏せ字にする。
const SECRET_LIKE_PATTERN = /\b(password|passwd|token|secret|authorization)\s*[:=]\s*\S+/gi;

function maskSecrets(text: string): string {
  return text.replace(SECRET_LIKE_PATTERN, (match) => {
    const separatorIndex = match.search(/[:=]/);
    return `${match.slice(0, separatorIndex + 1)} ***`;
  });
}

/**
 * cloudflared の出力の書き込み先を抽象化する(テストではフェイクを注入する)。
 *
 * 契約: write/close は例外を投げてはならない。呼び出し側 (onData / close ハンドラ)
 * は無防備に呼ぶため、投げるとログの都合でトンネル動作が壊れる — この方針は
 * 生成失敗にもフォールバックを入れて揃えた (bdboard-nte)。
 */
export interface LogSink {
  write(chunk: string): void;
  close(): void;
}

/**
 * filePath が maxBytes 以上であれば filePath -> `${filePath}.1` へリネームして退避する
 * (世代は1つのみ。既存の .1 があれば上書きされる)。ファイルが存在しない場合は何もしない。
 * 起動時チェック程度の粗い運用でよいため、書き込み中の継続監視は行わない。
 */
function rotateLogFileIfOversized(filePath: string, maxBytes: number): void {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return; // ファイルがまだ無い(初回起動など)
  }

  if (stats.size < maxBytes) {
    return;
  }

  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    // ローテーション失敗時は既存ファイルへの追記を続ける(ベストエフォート)
  }
}

/**
 * 何も書かないシンク。ログ出力先を用意できなかったときのフォールバック
 * (bdboard-nte)。
 */
function createNoopLogSink(): LogSink {
  return {
    write: () => {},
    close: () => {},
  };
}

function createFileLogSink(filePath: string, maxBytes: number): LogSink {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  rotateLogFileIfOversized(filePath, maxBytes);
  const fd = fs.openSync(filePath, 'a');
  return {
    write: (chunk: string) => {
      try {
        fs.writeSync(fd, chunk);
      } catch {
        // ログ書き込み失敗はトンネル動作自体を阻害しない
      }
    },
    close: () => {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed, ignore
      }
    },
  };
}

export interface DataStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
}

export interface SpawnedProcess {
  readonly stdout: DataStream | null;
  readonly stderr: DataStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
) => SpawnedProcess;

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

function resolveCloudflaredInPath(
  pathEnv: string,
  opts?: { platform?: NodeJS.Platform },
): string | null {
  const platform = opts?.platform ?? process.platform;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const executableName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const directories = pathEnv.split(platformPath.delimiter);

  for (const directory of directories) {
    if (directory.length === 0) {
      continue;
    }

    const candidate = platformPath.join(directory, executableName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next directory
    }
  }

  return null;
}

function appendChunk(buffer: string, chunk: Buffer | string): string {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  return buffer + text;
}

function extractTunnelUrl(buffer: string): string | null {
  const match = buffer.match(TRY_CLOUDFLARE_URL_PATTERN);
  return match?.[0] ?? null;
}

function asSpawnedProcess(child: ChildProcess): SpawnedProcess {
  const processHandle: SpawnedProcess = {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal?: NodeJS.Signals) => child.kill(signal),
    on: (event, listener) => {
      child.on(event, listener as never);
      return processHandle;
    },
  };
  return processHandle;
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

  let availabilityCache: boolean | null = null;
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

  const isAvailable = async (): Promise<boolean> => {
    if (availabilityCache !== null) {
      return availabilityCache;
    }

    availabilityCache = resolveExecutable() !== null;
    return availabilityCache;
  };

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

        outputBuffer = appendChunk(outputBuffer, chunk);
        const url = extractTunnelUrl(outputBuffer);
        if (url !== null) {
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
