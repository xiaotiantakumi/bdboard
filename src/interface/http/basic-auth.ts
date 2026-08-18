import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';

export interface BasicAuthConfig {
  readonly username: string;
  readonly password: string;
}

export type AuthMode =
  | { readonly kind: 'enabled'; readonly config: BasicAuthConfig }
  | { readonly kind: 'disabled-explicitly' }
  | { readonly kind: 'unconfigured' };

export interface BasicAuthMiddlewareOptions {
  readonly now?: () => Date;
  readonly maxFailures?: number;
  readonly lockDurationMs?: number;
  readonly getExtraCredentials?: () => BasicAuthConfig | null;
  readonly hasValidSession?: (c: Context) => boolean;
  readonly isLocalRequest?: (c: Context) => boolean;
}

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_LOCK_DURATION_MS = 60_000;

const WWW_AUTHENTICATE = 'Basic realm="bdboard", charset="UTF-8"';

const DUMMY_AUTH_CONFIG: BasicAuthConfig = {
  username: '\u0000',
  password: '\u0000',
};

/** 環境変数から認証モードを決める。純粋関数(process.env を直接読まず引数で受ける) */
export function resolveAuthMode(
  env: Readonly<Record<string, string | undefined>>,
): AuthMode {
  const user = env.BDBOARD_AUTH_USER;
  const password = env.BDBOARD_AUTH_PASSWORD;

  if (user !== undefined && user !== '' && password !== undefined && password !== '') {
    return { kind: 'enabled', config: { username: user, password } };
  }

  const disabled = env.BDBOARD_AUTH_DISABLED;
  if (disabled === '1' || disabled === 'true') {
    return { kind: 'disabled-explicitly' };
  }

  return { kind: 'unconfigured' };
}

function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a, 'utf8').digest();
  const hashB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(hashA, hashB);
}

function parseBasicAuth(
  header: string,
): { readonly username: string; readonly password: string } | null {
  // RFC 7235: the auth-scheme token is case-insensitive.
  if (!/^basic\s/i.test(header)) {
    return null;
  }

  const encoded = header.replace(/^basic\s+/i, '').trim();
  if (encoded.length === 0) {
    return null;
  }

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, colonIndex),
      password: decoded.slice(colonIndex + 1),
    };
  } catch {
    return null;
  }
}

function validateCredentials(
  provided: { readonly username: string; readonly password: string },
  config: BasicAuthConfig,
): boolean {
  const usernameMatch = constantTimeEqual(provided.username, config.username);
  const passwordMatch = constantTimeEqual(provided.password, config.password);
  return usernameMatch && passwordMatch;
}

function validateAgainstPrimaryAndExtra(
  provided: { readonly username: string; readonly password: string },
  primary: BasicAuthConfig,
  extra: BasicAuthConfig | null,
): boolean {
  // 環境変数由来とトンネル発行の資格情報を常に両方比較してから OR を取る。
  // どちらか一方で早期 return すると、一致した側がタイミングから推測される。
  const primaryMatch = validateCredentials(provided, primary);
  const extraTarget = extra ?? DUMMY_AUTH_CONFIG;
  const extraMatch = validateCredentials(provided, extraTarget);
  return primaryMatch || extraMatch;
}

interface ThrottleState {
  failureCount: number;
  lockedUntil: number | null;
}

interface EnabledAuthRuntime {
  readonly config: BasicAuthConfig;
  readonly getExtraCredentials?: () => BasicAuthConfig | null;
  readonly hasValidSession?: (c: Context) => boolean;
}

interface EnabledAuthHandlerDeps {
  readonly now: () => Date;
  readonly maxFailures: number;
  readonly lockDurationMs: number;
}

function createEnabledAuthHandler(deps: EnabledAuthHandlerDeps) {
  // quick tunnel 越しだとリクエスト元 IP がすべて同じに見えるため IP 別スロットリングは
  // 無意味になる可能性が高い。可用性より漏洩防止を優先し、グローバルカウンタを使う。
  const throttle: ThrottleState = {
    failureCount: 0,
    lockedUntil: null,
  };

  const checkAndClearLock = (): boolean => {
    if (throttle.lockedUntil === null) {
      return false;
    }

    const currentTime = deps.now().getTime();
    if (currentTime < throttle.lockedUntil) {
      return true;
    }

    throttle.failureCount = 0;
    throttle.lockedUntil = null;
    return false;
  };

  const remainingLockSeconds = (): number => {
    if (throttle.lockedUntil === null) {
      return 0;
    }
    const remaining = Math.ceil((throttle.lockedUntil - deps.now().getTime()) / 1000);
    return Math.max(remaining, 1);
  };

  const recordFailure = (): void => {
    throttle.failureCount += 1;
    if (throttle.failureCount >= deps.maxFailures) {
      throttle.lockedUntil = deps.now().getTime() + deps.lockDurationMs;
    }
  };

  const resetThrottle = (): void => {
    throttle.failureCount = 0;
    throttle.lockedUntil = null;
  };

  return async (
    c: Context,
    next: () => Promise<void>,
    runtime: EnabledAuthRuntime,
  ): Promise<Response | void> => {
    if (runtime.hasValidSession?.(c) === true) {
      await next();
      return;
    }

    if (checkAndClearLock()) {
      c.header('Retry-After', String(remainingLockSeconds()));
      return c.text('Too many failed authentication attempts', 429);
    }

    // Only a request that actually submits a credential pair counts as a failed
    // attempt. A missing or non-Basic Authorization header is what every first
    // browser request and every passing scanner looks like; counting those would
    // let anyone who merely knows the URL lock the owner out with ten hits, and
    // would let an attacker keep the board down forever at one request a minute
    // without ever guessing the password. Excluding them costs no brute-force
    // protection, because the password cannot be guessed without submitting it.
    const authHeader = c.req.header('Authorization');
    if (authHeader === undefined) {
      c.header('WWW-Authenticate', WWW_AUTHENTICATE);
      return c.text('Unauthorized', 401);
    }

    const credentials = parseBasicAuth(authHeader);
    if (credentials === null) {
      c.header('WWW-Authenticate', WWW_AUTHENTICATE);
      return c.text('Unauthorized', 401);
    }

    const extra = runtime.getExtraCredentials?.() ?? null;
    if (!validateAgainstPrimaryAndExtra(credentials, runtime.config, extra)) {
      recordFailure();
      c.header('WWW-Authenticate', WWW_AUTHENTICATE);
      return c.text('Unauthorized', 401);
    }

    resetThrottle();
    await next();
  };
}

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
