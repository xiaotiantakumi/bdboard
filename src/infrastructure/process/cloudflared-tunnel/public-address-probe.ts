/**
 * Cloudflare の trace エンドポイントから、トンネル URL ごとの公開 IP を取得する。
 * 結果は10分間キャッシュし、IPv4/IPv6 はそれぞれの経路で問い合わせる。
 */
import type { IncomingMessage, RequestOptions } from 'node:http';
import { get as httpsGet } from 'node:https';
import type { PublicAddressProbe, PublicAddresses } from '../../../application/ports/public-address-probe.js';

const REFRESH_MS = 10 * 60_000;
const TIMEOUT_MS = 5_000;

type HttpsGetter = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => { on(event: 'error', listener: () => void): unknown; setTimeout(milliseconds: number, callback: () => void): unknown; destroy(): unknown };

function readFamily(url: string, family: 4 | 6, get: HttpsGetter): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request: ReturnType<HttpsGetter>;
    try {
      request = get(new URL('/cdn-cgi/trace', url), { family, timeout: TIMEOUT_MS }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(null);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => finish(/^ip=(.+)$/m.exec(body)?.[1]?.trim() || null));
        response.on('error', () => finish(null));
      });
      request.on('error', () => finish(null));
      request.setTimeout(TIMEOUT_MS, () => { request.destroy(); finish(null); });
    } catch {
      finish(null);
    }
  });
}

export function createPublicAddressProbe(now: () => number = Date.now, get: HttpsGetter = httpsGet): PublicAddressProbe {
  const cache = new Map<string, { expiresAt: number; value: Promise<PublicAddresses> }>();
  return {
    probe(tunnelUrl) {
      const cached = cache.get(tunnelUrl);
      if (cached && cached.expiresAt > now()) return cached.value;
      const value = Promise.all([readFamily(tunnelUrl, 4, get), readFamily(tunnelUrl, 6, get)])
        .then(([ipv4, ipv6]) => ({ ipv4, ipv6 }));
      cache.set(tunnelUrl, { expiresAt: now() + REFRESH_MS, value });
      return value;
    },
  };
}
