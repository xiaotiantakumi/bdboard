import type { Hono } from 'hono';
import type { TunnelAccessService } from '../../application/tunnel/tunnel-access.js';
import {
  createBasicAuthMiddleware,
  type AuthMode,
  type BasicAuthConfig,
  type BasicAuthMiddlewareOptions,
} from './basic-auth.js';
import {
  createTunnelTokenExchangeMiddleware,
  createSessionValidator,
} from './tunnel-session.js';

export interface SecurityMountDeps {
  readonly authMode: AuthMode | (() => AuthMode);
  readonly access?: TunnelAccessService;
  readonly getExtraCredentials?: () => BasicAuthConfig | null;
  readonly secureCookie?: boolean;
  readonly basicAuthOptions?: Pick<
    BasicAuthMiddlewareOptions,
    'now' | 'maxFailures' | 'lockDurationMs'
  >;
}

/** セキュリティ関連ミドルウェアを正しい順序で mount する。
 *  順序: (1) トークン→Cookie 交換 (2) Basic 認証。この順序が逆転すると、
 *  トークン付きの初回アクセスが Cookie を受け取る前に 401 で弾かれる。 */
export function mountSecurityMiddleware(app: Hono, deps: SecurityMountDeps): void {
  const basicAuthOptions: BasicAuthMiddlewareOptions = {
    ...(deps.basicAuthOptions ?? {}),
    ...(deps.getExtraCredentials !== undefined
      ? { getExtraCredentials: deps.getExtraCredentials }
      : {}),
    ...(deps.access !== undefined
      ? { hasValidSession: createSessionValidator(deps.access) }
      : {}),
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
