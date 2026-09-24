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
//
// bdboard-sso1.57: createCloudflaredTunnel() 本体は可変状態を共有するクロージャ群のため
// bdboard-sso1.54 では分割せず残っていた(213行、上限200行を超過)。この本体を
// TunnelRuntimeState という明示的な状態オブジェクトへ組み替え、その状態を渡す形で
// さらに分割した:
//   - runtime-state.ts     : createCloudflaredTunnel() が持っていたクロージャ変数
//     (child / outputBuffer / unexpectedExitListeners) をまとめた状態オブジェクト
//   - spawn-tunnel-process.ts: spawn の関心
//   - wait-for-tunnel-url.ts: stdout/stderr ハンドラ登録・起動タイムアウトタイマー・
//     URL 検出の関心 (settled/fail/succeed の状態機械が3つを密結合させているため
//     1モジュールにまとめた。詳細は同ファイル冒頭のコメント)
//   - stop-controller.ts   : kill (stop / stopExistingSynchronously) の関心
//   - start-tunnel.ts      : 上記を「実行ファイル解決 → 同期停止 → spawn → ログシンク
//     生成 → 出力監視」の順で呼び出す start() 本体のオーケストレーション
// spawn → ログシンク生成 → タイマー開始・stdout/stderr ハンドラ登録(元のコードでも
// この2つはこの順)→ URL 検出 → kill という順序、タイムアウト時・プロセス早期終了時の
// 挙動は変えていない。公開 API (export の集合・createCloudflaredTunnel() の引数と
// 戻り値) も変えていない。
import { spawn as nodeSpawn } from 'node:child_process';
import type {
  TunnelProcess,
  TunnelStartResult,
} from '../../application/ports/tunnel.js';
import {
  resolveDefaultTunnelLogFilePath,
  DEFAULT_LOG_MAX_BYTES,
  createFileLogSink,
  type LogSink,
} from './cloudflared-tunnel/log-sink.js';
import {
  asSpawnedProcess,
  type SpawnedProcess,
  type SpawnFn,
} from './cloudflared-tunnel/spawned-process.js';
import { resolveCloudflaredInPath } from './cloudflared-tunnel/executable-resolver.js';
import { createTunnelRuntimeState } from './cloudflared-tunnel/runtime-state.js';
import {
  stopTunnelProcess,
  stopTunnelProcessSynchronously,
} from './cloudflared-tunnel/stop-controller.js';
import { startTunnel } from './cloudflared-tunnel/start-tunnel.js';

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

  const state = createTunnelRuntimeState();

  // キャッシュは持たない。ここは「今 PATH に cloudflared があるか」を素直に答える。
  // 以前は結果を恒久キャッシュしていたが、「見つからない」は brew install 一つで
  // 覆るので、固定するとサーバー再起動まで拾えなかった (bdboard-syr)。
  // キャッシュの責務は呼び出し元の tunnel-service に一元化してある (TTL 付き) —
  // ここにも置くと、二層のどちらが効いているのか追えなくなる。
  // 走査自体は PATH 46 エントリで実測 0.14ms 未満なので、素通しで問題ない。
  const isAvailable = async (): Promise<boolean> => resolveExecutable() !== null;

  const stop = (): Promise<void> => stopTunnelProcess(state, stopGraceMs);

  const stopExistingSynchronously = (): void =>
    stopTunnelProcessSynchronously(state);

  const start = (): Promise<TunnelStartResult> =>
    startTunnel({
      state,
      port: options.port,
      spawnFn,
      resolveExecutable,
      logFilePath,
      logMaxBytes,
      createLogSink,
      startTimeoutMs,
      stop,
      stopExistingSynchronously,
    });

  const onUnexpectedExit = (listener: () => void): void => {
    state.unexpectedExitListeners.push(listener);
  };

  return {
    start,
    onUnexpectedExit,
    stop,
    isAvailable,
  };
}
