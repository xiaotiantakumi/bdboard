import type { Context, MiddlewareHandler } from 'hono';
import type { AuthMode, BasicAuthConfig, BasicAuthMiddlewareOptions } from './types.js';
import { createEnabledAuthHandler, type EnabledAuthRuntime } from './enabled-auth-handler.js';

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_LOCK_DURATION_MS = 60_000;

function buildEnabledRuntime(
  config: BasicAuthConfig,
  options?: BasicAuthMiddlewareOptions,
): EnabledAuthRuntime {
  return {
    config,
    ...(options?.getExtraCredentials !== undefined
      ? { getExtraCredentials: options.getExtraCredentials }
      : {}),
    ...(options?.hasValidSession !== undefined
      ? { hasValidSession: options.hasValidSession }
      : {}),
  };
}

function resolveMode(
  modeOrGetter: AuthMode | (() => AuthMode),
): AuthMode {
  return typeof modeOrGetter === 'function' ? modeOrGetter() : modeOrGetter;
}

function respondUnconfigured(c: Context): Response {
  // fail-closed: 環境変数を1つ書き忘れただけで無言で全公開に戻る fail-open は、
  // まさに今回の情報露出を起こした形なので採らない。
  // 認証を外したい場合は BDBOARD_AUTH_DISABLED=1 を明示的に指定させる。
  // 401 ではなく 503 にするのは、「認証情報が違う」のではなく
  // 「サーバー側の設定が未完了」だと運用者に伝えるため。
  return c.text(
    'BDBOARD_AUTH_USER と BDBOARD_AUTH_PASSWORD を設定してください',
    503,
  );
}

async function handleNonEnabledAuthMode(
  c: Context,
  next: () => Promise<void>,
  mode: Exclude<AuthMode, { kind: 'enabled' }>,
): Promise<Response | void> {
  if (mode.kind === 'disabled-explicitly') {
    await next();
    return;
  }
  return respondUnconfigured(c);
}

function createMiddlewareForMode(
  mode: AuthMode,
  options?: BasicAuthMiddlewareOptions,
): MiddlewareHandler {
  if (mode.kind !== 'enabled') {
    return async (c, next) => handleNonEnabledAuthMode(c, next, mode);
  }

  const now = options?.now ?? ((): Date => new Date());
  const maxFailures = options?.maxFailures ?? DEFAULT_MAX_FAILURES;
  const lockDurationMs = options?.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS;

  const handleEnabledAuth = createEnabledAuthHandler({ now, maxFailures, lockDurationMs });
  const runtime = buildEnabledRuntime(mode.config, options);

  return async (c, next) => handleEnabledAuth(c, next, runtime);
}

function createDynamicMiddleware(
  modeGetter: () => AuthMode,
  options?: BasicAuthMiddlewareOptions,
): MiddlewareHandler {
  const now = options?.now ?? ((): Date => new Date());
  const maxFailures = options?.maxFailures ?? DEFAULT_MAX_FAILURES;
  const lockDurationMs = options?.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS;

  const handleEnabledAuth = createEnabledAuthHandler({ now, maxFailures, lockDurationMs });

  return async (c, next) => {
    const mode = resolveMode(modeGetter);
    if (mode.kind !== 'enabled') {
      return handleNonEnabledAuthMode(c, next, mode);
    }

    const runtime = buildEnabledRuntime(mode.config, options);
    return handleEnabledAuth(c, next, runtime);
  };
}

/** Hono のミドルウェアを作る */
export function createBasicAuthMiddleware(
  mode: AuthMode,
  options?: BasicAuthMiddlewareOptions,
): MiddlewareHandler;
export function createBasicAuthMiddleware(
  modeGetter: () => AuthMode,
  options?: BasicAuthMiddlewareOptions,
): MiddlewareHandler;
export function createBasicAuthMiddleware(
  modeOrGetter: AuthMode | (() => AuthMode),
  options?: BasicAuthMiddlewareOptions,
): MiddlewareHandler {
  const inner =
    typeof modeOrGetter === 'function'
      ? createDynamicMiddleware(modeOrGetter, options)
      : createMiddlewareForMode(modeOrGetter, options);

  const isLocalRequest = options?.isLocalRequest;
  if (isLocalRequest === undefined) {
    return inner;
  }

  return async (c, next) => {
    // ローカル直アクセスは mode を問わず常に免除する。unconfigured の 503 は
    // トンネルや将来のリモート越しに無防備公開される事故を防ぐための fail-closed であり、
    // isLocalRequest で確実にローカルと判定できるリクエストまで適用する必要はない。
    if (isLocalRequest(c)) {
      await next();
      return;
    }
    return inner(c, next);
  };
}
