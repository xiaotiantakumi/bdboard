// Builds the string encoded into the tunnel QR code.
//
// The QR carries a one-time access token as the `t` query parameter on the
// tunnel URL. Scanning it opens `https://<host>/?t=<token>`; the server
// exchanges that token for an HttpOnly session cookie and redirects to a
// clean URL. No credentials appear in the QR payload.

export const TUNNEL_TOKEN_QUERY_PARAM = 't';

/** QR に載せる値。トンネル URL に単回使用トークンをクエリとして付ける。
 *  資格情報は一切含まない。 */
export function buildTunnelTokenUrl(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  parsed.searchParams.set(TUNNEL_TOKEN_QUERY_PARAM, token);
  return parsed.toString();
}
