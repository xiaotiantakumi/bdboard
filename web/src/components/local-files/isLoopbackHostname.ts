/**
 * 開いているページのホスト名がローカル直アクセスのものか。サーバーのローカル判定 (src/interface/http/local-request.ts の hasExpectedLocalHost) が
 * 受ける `localhost` / `127.0.0.1` / `[::1]` と同じ集合 (ブラウザの hostname は IPv6 を `[::1]` と返すが、括弧なしも受ける)。
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]' || normalized === '::1';
}
