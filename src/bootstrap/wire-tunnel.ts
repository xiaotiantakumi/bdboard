/**
 * bdboard-sso1.14: src/main.ts (composition root) からトンネル領域の配線を
 * 切り出したもの (move only, 挙動変更ゼロ)。
 *
 * cloudflared プロセス制御・トンネルアクセス (パスワード/セッション)・
 * 中断記録・可用性プローブをまとめて組み立てる。writeAccess (write-guard の
 * 判定材料) はチャット (bdboard-cu4) とも共有する横断的な値のため、ここでは
 * 材料 (tunnelService / tunnelAccess) だけを返し、組み立ては main.ts 側で行う
 * (元のコード上の役割分担をそのまま保つ)。
 */
import { randomInt } from 'node:crypto';
import path from 'node:path';
import {
  createCloudflaredTunnel,
  resolveDefaultTunnelLogFilePath,
  createFileTunnelInterruptionStore,
} from '../infrastructure/index.js';
import {
  createTunnelAccessService,
  type TunnelAccessService,
} from '../application/tunnel/tunnel-access.js';
import { createTunnelService, type TunnelService } from '../application/tunnel/tunnel-service.js';
import { generatePassphrase } from '../domain/passphrase.js';
import { envInt, envString } from '../infrastructure/env.js';

export interface WireTunnelOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly port: number;
  /** トンネル中断記録の保存先を決めるための board cache DB パス。 */
  readonly dbPath: string;
  readonly authUsername: string;
  readonly log?: (message: string) => void;
}

export interface WireTunnelResult {
  readonly tunnelService: TunnelService;
  readonly tunnelAccess: TunnelAccessService;
}

export async function wireTunnel(options: WireTunnelOptions): Promise<WireTunnelResult> {
  const log = options.log ?? console.log;
  const tunnelLogMaxBytes = envInt(options.env, 'BDBOARD_TUNNEL_LOG_MAX_BYTES', 5 * 1024 * 1024);
  // 既定は ~/.bdboard/logs/cloudflared-tunnel.log (bdboard-3b0)。cwd 基準では
  // なくなったので、リポジトリ内にログを置きたい場合は明示的に指定してもらう。
  // path.resolve で起動時の cwd に対して一度だけ固定する。相対パスを渡された
  // まま createFileLogSink まで持っていくと、解決は start() 時点の cwd 基準に
  // なる — このチケットが潰そうとしている cwd 依存が、明示指定の裏口から
  // 戻ってくる (PR#111 fable レビュー minor-3)。
  const tunnelLogFilePath = path.resolve(
    envString(options.env, 'BDBOARD_TUNNEL_LOG_PATH', resolveDefaultTunnelLogFilePath()),
  );
  const tunnelProcess = createCloudflaredTunnel({
    port: options.port,
    logFilePath: tunnelLogFilePath,
    logMaxBytes: tunnelLogMaxBytes,
  });
  const tunnelAccess = createTunnelAccessService({ now: () => new Date() });
  const tunnelInterruptions = createFileTunnelInterruptionStore(
    path.join(path.dirname(options.dbPath), 'tunnel-interruption.json'),
  );
  const tunnelService = createTunnelService({
    tunnel: tunnelProcess,
    now: () => new Date(),
    username: options.authUsername,
    // Math.random is not a CSPRNG: V8's generator leaks its internal state to
    // anyone who observes enough output, and this passphrase is handed out over
    // a public URL. randomInt draws from the same pool as the rest of node:crypto.
    generatePassword: () => generatePassphrase(() => randomInt(0, 2 ** 32) / 2 ** 32),
    access: tunnelAccess,
    interruptions: tunnelInterruptions,
  });

  try {
    const tunnelAvailable = await tunnelService.probeAvailability();
    if (tunnelAvailable) {
      log('Tunnel: available');
    } else {
      log('Tunnel: not available (cloudflared not found)');
    }
  } catch {
    log('Tunnel: not available (cloudflared not found)');
  }

  return { tunnelService, tunnelAccess };
}
