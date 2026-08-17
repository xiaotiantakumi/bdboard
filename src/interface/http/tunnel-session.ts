import type { Context, MiddlewareHandler } from 'hono';
import type { TunnelAccessService } from '../../application/tunnel/tunnel-access.js';

export const TUNNEL_SESSION_COOKIE = 'bdboard_tunnel_session';
export const TUNNEL_TOKEN_QUERY_PARAM = 't';

export interface TunnelSessionMiddlewareDeps {
  readonly access: TunnelAccessService;
  /** テスト用。既定 true。false なら Secure 属性を付けない */
  readonly secureCookie?: boolean;
}

/** Cookie ヘッダから当該セッション Cookie の値を取り出す (純粋関数・テストしやすく) */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (cookieHeader === undefined || cookieHeader.length === 0) {
    return null;
  }

  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const name = trimmed.slice(0, eqIndex).trim();
    if (name === TUNNEL_SESSION_COOKIE) {
      return trimmed.slice(eqIndex + 1).trim();
    }
  }

  return null;
}

/** Basic 認証ミドルウェアに渡す「Cookie セッションが有効か」判定 */
export function createSessionValidator(
  access: TunnelAccessService,
): (c: Context) => boolean {
  return (c: Context): boolean => {
    const cookieHeader = c.req.header('Cookie');
    const sessionId = readSessionCookie(cookieHeader);
    if (sessionId === null) {
      return false;
    }
    return access.isValidSession(sessionId);
  };
}

function buildCleanUrl(c: Context): string {
  const url = new URL(c.req.url);
  url.searchParams.delete(TUNNEL_TOKEN_QUERY_PARAM);
  const query = url.searchParams.toString();
  // "//evil.com/" のようなパスをそのまま Location に載せると、ブラウザはスキーム相対URLと
  // 解釈して外部サイトへ遷移する(オープンリダイレクト)。先頭の連続スラッシュは1本に潰す。
  const path = url.pathname.replace(/^\/+/, '/');
  const pathWithQuery = query.length > 0 ? `${path}?${query}` : path;
  return pathWithQuery;
}

function buildSetCookieHeader(
  sessionId: string,
  expiresAt: Date,
  secure: boolean,
  now: Date,
): string {
  const maxAge = Math.max(Math.ceil((expiresAt.getTime() - now.getTime()) / 1000), 0);
  const parts = [
    `${TUNNEL_SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/** ?t=<token> を Cookie に交換するミドルウェア。basic-auth より前に mount する */
export function createTunnelTokenExchangeMiddleware(
  deps: TunnelSessionMiddlewareDeps,
): MiddlewareHandler {
  const secureCookie = deps.secureCookie ?? true;

  return async (c, next) => {
    const method = c.req.method;
    // HEAD は交換対象にしない。チャットのリンクプレビュー等がURLをプリフェッチすると、
    // 単回トークンがそこで消費され、セッションCookieが本人ではなくプリフェッチャに
    // 発行されてしまう(本人がタップした頃には401になる)。
    if (method !== 'GET') {
      await next();
      return;
    }

    const token = c.req.query(TUNNEL_TOKEN_QUERY_PARAM);
    if (token === undefined) {
      await next();
      return;
    }

    const result = deps.access.consumeToken(token);
    if (result === null) {
      await next();
      return;
    }

    const setCookie = buildSetCookieHeader(
      result.sessionId,
      result.expiresAt,
      secureCookie,
      new Date(),
    );
    c.header('Set-Cookie', setCookie);
    return c.redirect(buildCleanUrl(c), 302);
  };
}
