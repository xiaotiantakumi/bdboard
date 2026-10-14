import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { TunnelAccessService } from '../../application/tunnel/tunnel-access.js';
import {
  createBasicAuthMiddleware,
  type AuthMode,
  type BasicAuthConfig,
  type BasicAuthMiddlewareOptions,
} from './basic-auth.js';
import { isLocalBasicAuthRequest } from './local-request.js';
import {
  createTunnelTokenExchangeMiddleware,
  createSessionValidator,
} from './tunnel-session.js';

export interface SecurityMountDeps {
  readonly authMode: AuthMode | (() => AuthMode);
  readonly access?: TunnelAccessService;
  readonly getExtraCredentials?: () => BasicAuthConfig | null;
  readonly isLocalRequest?: (c: Context) => boolean;
  readonly secureCookie?: boolean;
  readonly basicAuthOptions?: Pick<
    BasicAuthMiddlewareOptions,
    'now' | 'maxFailures' | 'lockDurationMs'
  >;
}

/**
 * クリックジャッキング対策ヘッダを全レスポンスに付与する(bdboard-3tw.137
 * レビュー MAJOR-A)。ローカル直アクセスが Basic 認証免除になったことで、
 * 外部サイトが `<iframe>` でこのボードを埋め込み、UI 偽装(クリック
 * ジャッキング)でトンネル公開等の操作を誘発できてしまうリスクが生まれた。
 * 401 応答を含む全レスポンスに付与する(認証プロンプト自体の偽装も防ぐため、
 * 認証ミドルウェアより前段で next() の前後どちらでも確実に効くよう最初に mount)。
 * ルートが付けた CSP (raw の sandbox 等) は残し、frame-ancestors だけを 'none' に揃える。
 */
function securityHeadersMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set(
      'Content-Security-Policy',
      withFrameAncestorsNone(c.res.headers.get('Content-Security-Policy')),
    );
  };
}

/** ルートが付けた CSP を残したまま frame-ancestors 'none' を必ず効かせる (bdboard-vgdr)。 */
export function withFrameAncestorsNone(existing: string | null): string {
  const locked = "frame-ancestors 'none'";
  if (existing === null || existing.trim() === '') {
    return locked;
  }
  const kept: string[] = [];
  for (const raw of existing.split(';')) {
    const part = raw.trim();
    if (part === '') continue;
    const spaceAt = part.search(/\s/);
    const name = (spaceAt === -1 ? part : part.slice(0, spaceAt)).toLowerCase();
    if (name === 'frame-ancestors') continue;
    kept.push(part);
  }
  return kept.length === 0 ? locked : `${kept.join('; ')}; ${locked}`;
}

/** セキュリティ関連ミドルウェアを正しい順序で mount する。
 *  順序: (0) クリックジャッキング対策ヘッダ (1) トークン→Cookie 交換
 *  (2) Basic 認証。(1)(2) の順序が逆転すると、トークン付きの初回アクセスが
 *  Cookie を受け取る前に 401 で弾かれる。 */
export function mountSecurityMiddleware(app: Hono, deps: SecurityMountDeps): void {
  app.use('*', securityHeadersMiddleware());

  const basicAuthOptions: BasicAuthMiddlewareOptions = {
    ...(deps.basicAuthOptions ?? {}),
    ...(deps.getExtraCredentials !== undefined
      ? { getExtraCredentials: deps.getExtraCredentials }
      : {}),
    ...(deps.access !== undefined
      ? { hasValidSession: createSessionValidator(deps.access) }
      : {}),
    isLocalRequest: deps.isLocalRequest ?? isLocalBasicAuthRequest,
  };

  if (deps.access !== undefined) {
    app.use(
      '*',
      createTunnelTokenExchangeMiddleware({
        access: deps.access,
        ...(deps.secureCookie !== undefined ? { secureCookie: deps.secureCookie } : {}),
      }),
    );
  }

  // Narrow the union explicitly: createBasicAuthMiddleware is overloaded on
  // AuthMode vs () => AuthMode, and a union argument matches neither overload.
  const authMode = deps.authMode;
  if (typeof authMode === 'function') {
    app.use('*', createBasicAuthMiddleware(authMode, basicAuthOptions));
  } else {
    app.use('*', createBasicAuthMiddleware(authMode, basicAuthOptions));
  }
}
