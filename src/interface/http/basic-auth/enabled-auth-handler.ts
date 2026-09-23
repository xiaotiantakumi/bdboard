import type { Context } from 'hono';
import type { BasicAuthConfig } from './types.js';
import { parseBasicAuth, validateAgainstPrimaryAndExtra } from './credentials.js';

const WWW_AUTHENTICATE = 'Basic realm="bdboard", charset="UTF-8"';

interface ThrottleState {
  failureCount: number;
  lockedUntil: number | null;
}

export interface EnabledAuthRuntime {
  readonly config: BasicAuthConfig;
  readonly getExtraCredentials?: () => BasicAuthConfig | null;
  readonly hasValidSession?: (c: Context) => boolean;
}

interface EnabledAuthHandlerDeps {
  readonly now: () => Date;
  readonly maxFailures: number;
  readonly lockDurationMs: number;
}

export function createEnabledAuthHandler(deps: EnabledAuthHandlerDeps) {
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
