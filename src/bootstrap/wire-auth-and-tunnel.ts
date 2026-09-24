/**
 * bdboard-sso1.86: src/main.ts (composition root) から basic auth モード解決・
 * トンネル配線・書き込みガード材料 (writeAccess) の組み立てを切り出したもの
 * (move only, 挙動変更ゼロ)。
 *
 * トンネル経由の書き込み開放 (bdboard-9rz) の判定は write-guard 1 箇所に集約して
 * あるので、ここでは材料 (パスワード強度・セッション Cookie の有効性) を渡すだけ。
 * bdboard-cu4 でチャットも同じ材料を共有する (片方だけ緩むのを構造的に防ぐ)。
 */
import { resolveAuthMode } from '../interface/http/basic-auth.js';
import { createSessionValidator } from '../interface/http/tunnel-session.js';
import { envString } from './env.js';
import { wireTunnel } from './wire-tunnel.js';

export interface WireAuthAndTunnelDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly port: number;
  readonly dbPath: string;
  readonly tunnelLogFilePath: string;
  readonly log?: (message: string) => void;
}

export async function wireAuthAndTunnel(deps: WireAuthAndTunnelDeps) {
  const log = deps.log ?? console.log;

  const authMode = resolveAuthMode(deps.env);
  const authUsername = envString('BDBOARD_AUTH_USER', 'bdboard');

  const { tunnelService, tunnelAccess } = await wireTunnel({
    env: deps.env,
    port: deps.port,
    dbPath: deps.dbPath,
    tunnelLogFilePath: deps.tunnelLogFilePath,
    authUsername,
  });

  if (authMode.kind === 'enabled') {
    log('Basic auth: enabled');
  } else if (authMode.kind === 'disabled-explicitly') {
    log('Basic auth: DISABLED explicitly (BDBOARD_AUTH_DISABLED)');
  } else {
    log(
      'Basic auth: not configured; local direct requests are allowed, while remote requests return 503 and tunnel publishing is disabled. Set BDBOARD_AUTH_USER and BDBOARD_AUTH_PASSWORD to publish.',
    );
  }

  const writeAccess = {
    isTunnelWriteAllowed: () => tunnelService.isWriteAllowed(),
    hasTunnelSession: createSessionValidator(tunnelAccess),
  };

  return { authMode, authUsername, tunnelService, tunnelAccess, writeAccess };
}
