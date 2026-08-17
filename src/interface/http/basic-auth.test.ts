import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  createBasicAuthMiddleware,
  resolveAuthMode,
} from './basic-auth.js';

// Placeholder-shaped on purpose: adjacent USER/PASSWORD fixture constants
// are what GitGuardian's Username Password detector fires on by pattern,
// regardless of whether the value is a real secret (see CLAUDE.md).
const USER = 'example-user';
const PASSWORD = 'example-password';

function basicAuthHeader(user: string, pass: string): string {
  const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
  return `Basic ${encoded}`;
}

function createTestApp(
  mode: ReturnType<typeof resolveAuthMode>,
  options?: Parameters<typeof createBasicAuthMiddleware>[1],
): Hono {
  const app = new Hono();
  app.use('*', createBasicAuthMiddleware(mode, options));
  app.get('/test', (c) => c.text('ok', 200));
  return app;
}

describe('resolveAuthMode', () => {
  it('returns enabled when both USER and PASSWORD are set', () => {
    const mode = resolveAuthMode({
      BDBOARD_AUTH_USER: USER,
      BDBOARD_AUTH_PASSWORD: PASSWORD,
    });
    expect(mode).toEqual({
      kind: 'enabled',
      config: { username: USER, password: PASSWORD },
    });
  });

  it('returns unconfigured when only USER is set', () => {
    const mode = resolveAuthMode({
      BDBOARD_AUTH_USER: USER,
    });
    expect(mode).toEqual({ kind: 'unconfigured' });
  });

  it('returns unconfigured when only PASSWORD is set', () => {
    const mode = resolveAuthMode({
      BDBOARD_AUTH_PASSWORD: PASSWORD,
    });
    expect(mode).toEqual({ kind: 'unconfigured' });
  });

  it('returns unconfigured when neither is set', () => {
    const mode = resolveAuthMode({});
    expect(mode).toEqual({ kind: 'unconfigured' });
  });

  it('returns unconfigured when both are empty strings', () => {
    const mode = resolveAuthMode({
      BDBOARD_AUTH_USER: '',
      BDBOARD_AUTH_PASSWORD: '',
    });
    expect(mode).toEqual({ kind: 'unconfigured' });
  });

  it('returns disabled-explicitly when BDBOARD_AUTH_DISABLED is 1', () => {
    const mode = resolveAuthMode({ BDBOARD_AUTH_DISABLED: '1' });
    expect(mode).toEqual({ kind: 'disabled-explicitly' });
  });

  it('returns disabled-explicitly when BDBOARD_AUTH_DISABLED is true', () => {
    const mode = resolveAuthMode({ BDBOARD_AUTH_DISABLED: 'true' });
    expect(mode).toEqual({ kind: 'disabled-explicitly' });
  });

  it('returns enabled when both credentials are set even if DISABLED is 1', () => {
    const mode = resolveAuthMode({
      BDBOARD_AUTH_USER: USER,
      BDBOARD_AUTH_PASSWORD: PASSWORD,
      BDBOARD_AUTH_DISABLED: '1',
    });
    expect(mode).toEqual({
      kind: 'enabled',
      config: { username: USER, password: PASSWORD },
    });
  });
});

describe('createBasicAuthMiddleware', () => {
  const enabledMode = {
    kind: 'enabled' as const,
    config: { username: USER, password: PASSWORD },
  };

  it('returns 503 for unconfigured mode and does not reach handler', async () => {
    const app = createTestApp({ kind: 'unconfigured' });
    const res = await app.request('/test');
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('BDBOARD_AUTH_USER');
    expect(body).toContain('BDBOARD_AUTH_PASSWORD');
  });

  it('returns 200 with valid credentials in enabled mode', async () => {
    const app = createTestApp(enabledMode);
    const res = await app.request('/test', {
      headers: { Authorization: basicAuthHeader(USER, PASSWORD) },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('returns 401 without Authorization header', async () => {
    const app = createTestApp(enabledMode);
    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('WWW-Authenticate');
    expect(wwwAuth).toContain('Basic realm="bdboard"');
  });

  it('returns 401 with wrong password', async () => {
    const app = createTestApp(enabledMode);
    const res = await app.request('/test', {
      headers: { Authorization: basicAuthHeader(USER, 'wrong-password') },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Basic realm="bdboard"');
  });

  it('returns 401 with wrong username', async () => {
    const app = createTestApp(enabledMode);
    const res = await app.request('/test', {
      headers: { Authorization: basicAuthHeader('wrong-user', PASSWORD) },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for invalid base64 without throwing', async () => {
    const app = createTestApp(enabledMode);
    const res = await app.request('/test', {
      headers: { Authorization: 'Basic !!!not-base64!!!' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for non-Basic scheme', async () => {
    const app = createTestApp(enabledMode);
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer some-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when decoded value has no colon', async () => {
    const encoded = Buffer.from('nocolon').toString('base64');
    const app = createTestApp(enabledMode);
    const res = await app.request('/test', {
      headers: { Authorization: `Basic ${encoded}` },
    });
    expect(res.status).toBe(401);
  });

  it('accepts password containing colons (split at first colon)', async () => {
    const passwordWithColon = 'example-password:with-colon';
    const mode = {
      kind: 'enabled' as const,
      config: { username: USER, password: passwordWithColon },
    };
    const app = createTestApp(mode);
    const res = await app.request('/test', {
      headers: { Authorization: basicAuthHeader(USER, passwordWithColon) },
    });
    expect(res.status).toBe(200);
  });

  it('passes through in disabled-explicitly mode without Authorization', async () => {
    const app = createTestApp({ kind: 'disabled-explicitly' });
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  describe('brute-force throttling', () => {
    it('does not count requests that submit no credentials', async () => {
      // Anyone who merely knows the URL could otherwise lock the owner out with
      // ten credential-less hits, and keep the board down at one request a minute.
      const app = createTestApp(enabledMode, {
        maxFailures: 10,
        lockDurationMs: 60_000,
      });

      for (let i = 0; i < 30; i += 1) {
        const res = await app.request('/test');
        expect(res.status).toBe(401);
      }

      const withNonBasicScheme = await app.request('/test', {
        headers: { Authorization: 'Bearer some-token' },
      });
      expect(withNonBasicScheme.status).toBe(401);

      const authorized = await app.request('/test', {
        headers: { Authorization: basicAuthHeader(USER, PASSWORD) },
      });
      expect(authorized.status).toBe(200);
    });

    it('returns 429 after 10 consecutive failures with Retry-After header', async () => {
      let currentTime = new Date('2026-01-01T00:00:00.000Z');
      const app = createTestApp(enabledMode, {
        now: () => currentTime,
        maxFailures: 10,
        lockDurationMs: 60_000,
      });

      for (let i = 0; i < 10; i += 1) {
        const res = await app.request('/test', {
          headers: { Authorization: basicAuthHeader(USER, 'wrong') },
        });
        expect(res.status).toBe(401);
      }

      const locked = await app.request('/test', {
        headers: { Authorization: basicAuthHeader(USER, 'wrong') },
      });
      expect(locked.status).toBe(429);
      const retryAfter = locked.headers.get('Retry-After');
      expect(retryAfter).not.toBeNull();
      expect(Number(retryAfter)).toBeGreaterThan(0);
    });

    it('returns 429 for valid credentials while locked', async () => {
      let currentTime = new Date('2026-01-01T00:00:00.000Z');
      const app = createTestApp(enabledMode, {
        now: () => currentTime,
        maxFailures: 10,
        lockDurationMs: 60_000,
      });

      for (let i = 0; i < 10; i += 1) {
        await app.request('/test', {
          headers: { Authorization: basicAuthHeader(USER, 'wrong') },
        });
      }

      const res = await app.request('/test', {
        headers: { Authorization: basicAuthHeader(USER, PASSWORD) },
      });
      expect(res.status).toBe(429);
    });

    it('allows retry after lock expires', async () => {
      let currentTime = new Date('2026-01-01T00:00:00.000Z');
      const app = createTestApp(enabledMode, {
        now: () => currentTime,
        maxFailures: 10,
        lockDurationMs: 60_000,
      });

      for (let i = 0; i < 10; i += 1) {
        await app.request('/test', {
          headers: { Authorization: basicAuthHeader(USER, 'wrong') },
        });
      }

      const locked = await app.request('/test', {
        headers: { Authorization: basicAuthHeader(USER, PASSWORD) },
      });
      expect(locked.status).toBe(429);

      currentTime = new Date(currentTime.getTime() + 60_001);

      const afterUnlock = await app.request('/test', {
        headers: { Authorization: basicAuthHeader(USER, PASSWORD) },
      });
      expect(afterUnlock.status).toBe(200);
    });

    it('resets failure counter on successful auth', async () => {
      let currentTime = new Date('2026-01-01T00:00:00.000Z');
      const app = createTestApp(enabledMode, {
        now: () => currentTime,
        maxFailures: 10,
        lockDurationMs: 60_000,
      });

      for (let i = 0; i < 9; i += 1) {
        const res = await app.request('/test', {
          headers: { Authorization: basicAuthHeader(USER, 'wrong') },
        });
        expect(res.status).toBe(401);
      }

      const success = await app.request('/test', {
        headers: { Authorization: basicAuthHeader(USER, PASSWORD) },
      });
      expect(success.status).toBe(200);

      for (let i = 0; i < 9; i += 1) {
        const res = await app.request('/test', {
          headers: { Authorization: basicAuthHeader(USER, 'wrong') },
        });
        expect(res.status).toBe(401);
      }

      const notLocked = await app.request('/test', {
        headers: { Authorization: basicAuthHeader(USER, 'wrong') },
      });
      expect(notLocked.status).toBe(401);
    });
  });

  describe('dynamic credentials', () => {
    const enabledMode = {
      kind: 'enabled' as const,
      config: { username: USER, password: PASSWORD },
    };

    it('works with getter form for auth mode', async () => {
      const app = new Hono();
      app.use('*', createBasicAuthMiddleware(() => enabledMode));
      app.get('/test', (c) => c.text('ok', 200));

      const res = await app.request('/test', {
        headers: { Authorization: basicAuthHeader(USER, PASSWORD) },
      });
      expect(res.status).toBe(200);
    });

    it('returns 429 after repeated failures in getter form', async () => {
      let currentTime = new Date('2026-01-01T00:00:00.000Z');
      const app = new Hono();
      app.use(
        '*',
        createBasicAuthMiddleware(() => enabledMode, {
          now: () => currentTime,
          maxFailures: 10,
          lockDurationMs: 60_000,
        }),
      );
      app.get('/test', (c) => c.text('ok', 200));

      for (let i = 0; i < 10; i += 1) {
        const res = await app.request('/test', {
          headers: { Authorization: basicAuthHeader(USER, 'wrong') },
        });
        expect(res.status).toBe(401);
      }

      const locked = await app.request('/test', {
        headers: { Authorization: basicAuthHeader(USER, 'wrong') },
      });
      expect(locked.status).toBe(429);
    });

    it('accepts tunnel-issued credentials via getExtraCredentials', async () => {
      const app = createTestApp(enabledMode, {
        getExtraCredentials: () => ({
          username: 'example-tunnel-user',
          password: 'example-tunnel-password',
        }),
      });

      const res = await app.request('/test', {
        headers: {
          Authorization: basicAuthHeader('example-tunnel-user', 'example-tunnel-password'),
        },
      });
      expect(res.status).toBe(200);
    });

    it('still accepts environment credentials when extra credentials exist', async () => {
      const app = createTestApp(enabledMode, {
        getExtraCredentials: () => ({
          username: 'example-tunnel-user',
          password: 'example-tunnel-password',
        }),
      });

      const res = await app.request('/test', {
        headers: { Authorization: basicAuthHeader(USER, PASSWORD) },
      });
      expect(res.status).toBe(200);
    });

    it('returns 401 when neither environment nor tunnel credentials match', async () => {
      const app = createTestApp(enabledMode, {
        getExtraCredentials: () => ({
          username: 'example-tunnel-user',
          password: 'example-tunnel-password',
        }),
      });

      const res = await app.request('/test', {
        headers: { Authorization: basicAuthHeader('other', 'wrong') },
      });
      expect(res.status).toBe(401);
    });

    it('rejects tunnel credentials after getExtraCredentials returns null', async () => {
      const app = createTestApp(enabledMode, {
        getExtraCredentials: () => null,
      });

      const res = await app.request('/test', {
        headers: {
          Authorization: basicAuthHeader('example-tunnel-user', 'example-tunnel-password'),
        },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('cookie session bypass', () => {
    it('allows access with valid session in static mode', async () => {
      const app = createTestApp(enabledMode, {
        hasValidSession: () => true,
      });

      const res = await app.request('/test');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    });

    it('allows access with valid session in dynamic modeGetter', async () => {
      const app = new Hono();
      app.use(
        '*',
        createBasicAuthMiddleware(() => enabledMode, {
          hasValidSession: () => true,
        }),
      );
      app.get('/test', (c) => c.text('ok', 200));

      const res = await app.request('/test');
      expect(res.status).toBe(200);
    });

    it('returns 401 when session is invalid', async () => {
      const app = createTestApp(enabledMode, {
        hasValidSession: () => false,
      });

      const res = await app.request('/test');
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toContain('Basic realm="bdboard"');
    });

    it('returns 503 for unconfigured mode even with valid session', async () => {
      const app = createTestApp({ kind: 'unconfigured' }, {
        hasValidSession: () => true,
      });

      const res = await app.request('/test');
      expect(res.status).toBe(503);
    });

    it('works without hasValidSession (backward compatible)', async () => {
      const app = createTestApp(enabledMode);
      const res = await app.request('/test', {
        headers: { Authorization: basicAuthHeader(USER, PASSWORD) },
      });
      expect(res.status).toBe(200);
    });
  });
});
