// bdboard-sso1.57: createCloudflaredTunnel() の start() 本体。実行ファイル解決 → 前回
// プロセスの同期停止 → spawn → ログシンク生成 → 出力監視(waitForTunnelUrl)、という
// 元のコードの手順をそのままこの1関数にまとめている(呼び出す各関心は別モジュールへ切り出した
// が、この関数自身が持つ「どの順で呼ぶか」という並びは変えていない)。
import type { TunnelStartResult } from '../../../application/ports/tunnel.js';
import type { SpawnFn } from './spawned-process.js';
import { createNoopLogSink, type LogSink } from './log-sink.js';
import type { TunnelRuntimeState } from './runtime-state.js';
import { spawnTunnelProcess } from './spawn-tunnel-process.js';
import { waitForTunnelUrl } from './wait-for-tunnel-url.js';

export interface StartTunnelOptions {
  readonly state: TunnelRuntimeState;
  readonly port: number;
  readonly spawnFn: SpawnFn;
  readonly resolveExecutable: () => string | null;
  readonly logFilePath: string;
  readonly logMaxBytes: number;
  readonly createLogSink: (filePath: string, maxBytes: number) => LogSink;
  readonly startTimeoutMs: number;
  readonly stop: () => Promise<void>;
  readonly stopExistingSynchronously: () => void;
}

export function startTunnel(
  options: StartTunnelOptions,
): Promise<TunnelStartResult> {
  const executable = options.resolveExecutable();
  if (executable === null) {
    return Promise.reject(
      new Error('cloudflared executable not found in PATH'),
    );
  }

  options.stopExistingSynchronously();

  const processHandle = spawnTunnelProcess(
    options.state,
    options.spawnFn,
    executable,
    options.port,
  );

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
    logSink = options.createLogSink(options.logFilePath, options.logMaxBytes);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `cloudflared log sink unavailable (${options.logFilePath}): ${detail}. Continuing without a tunnel log.`,
    );
    logSink = createNoopLogSink();
  }
  logSink.write(`\n[${new Date().toISOString()}] cloudflared starting (port ${options.port})\n`);

  return waitForTunnelUrl({
    processHandle,
    state: options.state,
    logSink,
    startTimeoutMs: options.startTimeoutMs,
    stop: options.stop,
  });
}
