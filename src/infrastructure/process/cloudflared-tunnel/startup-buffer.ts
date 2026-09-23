// bdboard-sso1.54: cloudflared-tunnel.ts の move-only 分割で切り出した起動待ち中の
// stdout/stderr バッファ管理(蓄積上限・トンネル URL 抽出)。挙動は一切変えていない
// (移動のみ)。

const TRY_CLOUDFLARE_URL_PATTERN =
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** URL 待ち中の stdout/stderr 蓄積上限。超過分は末尾を残して切り詰める。 */
export const STARTUP_OUTPUT_BUFFER_MAX_BYTES = 256 * 1024;

export function appendStartupOutputBuffer(
  buffer: string,
  chunk: Buffer | string,
  maxBytes: number = STARTUP_OUTPUT_BUFFER_MAX_BYTES,
): string {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const combined = buffer + text;
  if (combined.length <= maxBytes) {
    return combined;
  }
  // URL がチャンク境界で分割されるケースに備え、古い先頭を捨てて末尾を残す。
  return combined.slice(combined.length - maxBytes);
}

export function extractTunnelUrl(buffer: string): string | null {
  const match = buffer.match(TRY_CLOUDFLARE_URL_PATTERN);
  return match?.[0] ?? null;
}
