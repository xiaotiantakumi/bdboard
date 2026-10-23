// Builds the string encoded into the tunnel QR code.
//
// The QR carries a one-time access token as the `t` query parameter on the
// tunnel URL. Scanning it opens `https://<host>/?t=<token>`; the server
// exchanges that token for an HttpOnly session cookie and redirects to a
// clean URL. No credentials appear in the QR payload.

import { PROJECTS_QUERY_PARAM, encodeProjectsParam } from './selectedProjectsBootstrap';

export const TUNNEL_TOKEN_QUERY_PARAM = 't';

/** QR に載せる値。トンネル URL に単回使用トークンをクエリとして付ける。
 *  資格情報は一切含まない。 */
export function buildTunnelTokenUrl(
  url: string,
  token: string,
  selectedProjectIds: readonly string[] = [],
): string {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  parsed.searchParams.set(TUNNEL_TOKEN_QUERY_PARAM, token);
  // bdboard-u8p9: PC の現在のプロジェクト選択も運ぶ (空 = 全プロジェクトなので付けない)。
  // 値は `,` 区切りの URL エンコード済み ID。searchParams に渡すと区切りの `,` まで
  // %2C になってしまうので、組み立てた文字列を手で付ける。
  const base = parsed.toString();
  if (selectedProjectIds.length === 0) {
    return base;
  }
  const joiner = parsed.search.length > 0 ? '&' : '?';
  const hashIndex = base.indexOf('#');
  const head = hashIndex === -1 ? base : base.slice(0, hashIndex);
  const tail = hashIndex === -1 ? '' : base.slice(hashIndex);
  return `${head}${joiner}${PROJECTS_QUERY_PARAM}=${encodeProjectsParam(selectedProjectIds)}${tail}`;
}
