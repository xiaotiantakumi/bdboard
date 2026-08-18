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

export function readLocalPort(env: unknown): number | null {
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
  const localPort = socketRecord.localPort;
  if (
    !Number.isInteger(localPort) ||
    (localPort as number) < 1 ||
    (localPort as number) > 65_535
  ) {
    return null;
  }

  return localPort as number;
}

export function hasCloudflareTunnelHeaders(headers: Headers): boolean {
  for (const name of CF_TUNNEL_HEADERS) {
    if (headers.get(name) !== null) {
      return true;
    }
  }
  return false;
}

export function hasExpectedLocalHost(
  headers: Headers,
  localPort: number,
): boolean {
  const host = headers.get('host');
  if (host === null || host.length === 0) {
    return false;
  }

  try {
    const parsed = new URL(`http://${host}`);
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname !== 'localhost' &&
      hostname !== '127.0.0.1' &&
      hostname !== '[::1]'
    ) {
      return false;
    }

    // bdboard is an HTTP server, so an omitted Host port means 80. For the
    // normal :8787 listener the browser must send the explicit, actual port.
    const requestedPort =
      parsed.port.length === 0 ? 80 : Number.parseInt(parsed.port, 10);
    return requestedPort === localPort;
  } catch {
    return false;
  }
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

/**
 * Basic Auth のローカル免除は DNS rebinding に対しても fail-closed にする。
 *
 * TCP/Cloudflare 判定だけで権限を与えた後、Host は追加の絞り込みにだけ使う。
 * Host を偽装しても免除を得ることはできず、期待値と違えば免除が外れるだけである。
 */
export function isLocalBasicAuthRequest(c: Context): boolean {
  if (!isLocalControlRequest(c)) {
    return false;
  }

  const localPort = readLocalPort(c.env);
  if (localPort === null) {
    return false;
  }

  return hasExpectedLocalHost(c.req.raw.headers, localPort);
}
