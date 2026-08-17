import type { Context } from 'hono';

export const CF_TUNNEL_HEADERS = [
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
] as const;

export function isLoopbackAddress(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

export function readRemoteAddress(env: unknown): string | null {
  if (typeof env !== 'object' || env === null) {
    return null;
  }

  const record = env as Record<string, unknown>;
  const incoming = record.incoming;
  if (typeof incoming !== 'object' || incoming === null) {
    return null;
  }

  const incomingRecord = incoming as Record<string, unknown>;
  const socket = incomingRecord.socket;
  if (typeof socket !== 'object' || socket === null) {
    return null;
  }

  const socketRecord = socket as Record<string, unknown>;
  const remoteAddress = socketRecord.remoteAddress;
  if (typeof remoteAddress !== 'string' || remoteAddress.length === 0) {
    return null;
  }

  return remoteAddress;
}

export function hasCloudflareTunnelHeaders(headers: Headers): boolean {
  for (const name of CF_TUNNEL_HEADERS) {
    if (headers.get(name) !== null) {
      return true;
    }
  }
  return false;
}

export function isLocalControlRequest(c: Context): boolean {
  // cloudflared はローカルサーバーへ 127.0.0.1 から接続するため、トンネル経由の
  // リクエストも送信元アドレスはループバックに見える。送信元だけではローカル直アクセスと
  // トンネル経由を区別できないので、Cloudflare が付与する転送ヘッダの有無も併せて見る。
  const remoteAddress = readRemoteAddress(c.env);
  if (remoteAddress === null || !isLoopbackAddress(remoteAddress)) {
    return false;
  }

  if (hasCloudflareTunnelHeaders(c.req.raw.headers)) {
    return false;
  }

  return true;
}
