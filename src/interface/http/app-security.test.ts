import { describe, expect, it } from 'vitest';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { createTunnelAccessService } from '../../application/tunnel/tunnel-access.js';
import { mountSecurityMiddleware } from './app-security.js';
import { TUNNEL_SESSION_COOKIE, TUNNEL_TOKEN_QUERY_PARAM } from './tunnel-session.js';

// Placeholder-shaped on purpose: adjacent USER/PASSWORD fixture constants
// are what GitGuardian's Username Password detector fires on by pattern,
// regardless of whether the value is a real secret (see CLAUDE.md).
const USER = 'example-user';
const PASSWORD = 'example-password';

const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
      localPort: 8787,
    },
  },
};

const REMOTE_ENV = {
  incoming: {
    socket: {
      remoteAddress: '203.0.113.5',
    },
  },
};

describe('mountSecurityMiddleware', () => {
  it('registers token exchange before basic auth', async () => {
    const handlers: MiddlewareHandler[] = [];
    const stubApp = {
      use: (_path: string, handler: MiddlewareHandler) => {
        handlers.push(handler);
      },
    } as unknown as Hono;

    const access = createTunnelAccessService({ now: () => new Date() });
    mountSecurityMiddleware(stubApp, {
      authMode: {
        kind: 'enabled',
        config: { username: USER, password: PASSWORD },
      },
      access,
    });

    // 3 handlers as of bdboard-3tw.137 MAJOR-A: [0] クリックジャッキング対策
    // ヘッダ, [1] トークン→Cookie 交換, [2] Basic 認証。
    expect(handlers.length).toBe(3);

    access.beginTunnelSession();
    const issued = access.issueToken();
    expect(issued).not.toBeNull();

    let firstNextCalled = false;
    const firstContext = {
      req: {
        method: 'GET',
        query: (name: string) =>
          name === TUNNEL_TOKEN_QUERY_PARAM ? issued!.token : undefined,
        url: `http://localhost/?${TUNNEL_TOKEN_QUERY_PARAM}=${issued!.token}`,
        header: () => undefined,
      },
      header: () => {},
      redirect: (location: string, status: number) => ({ location, status }),
    };

    await handlers[1](firstContext as never, async () => {
      firstNextCalled = true;
    });
    expect(firstNextCalled).toBe(false);

    let secondNextCalled = false;
    const unauthorizedContext = {
      req: {
        method: 'GET',
        query: () => undefined,
        url: 'http://localhost/',
        header: (name: string) => (name === 'Authorization' ? undefined : undefined),
      },
      header: () => {},
      text: (_body: string, status: number) => status,
    };

    const status = await handlers[2](unauthorizedContext as never, async () => {
      secondNextCalled = true;
    });
    expect(secondNextCalled).toBe(false);
    expect(status).toBe(401);
  });

  describe('behavioral mount order', () => {
    function createSecuredApp(access = createTunnelAccessService({ now: () => new Date() })) {
      const app = new Hono();
      // Hono dispatches in registration order, so the security middleware has to
      // be mounted before the route it is meant to protect. Registering the
      // route first would let every request through untouched.
      mountSecurityMiddleware(app, {
        authMode: {
          kind: 'enabled',
          config: { username: USER, password: PASSWORD },
        },
        access,
        secureCookie: true,
      });
      app.get('/', (c) => c.text('ok', 200));
      return { app, access };
    }

    it('exchanges a valid token for a cookie via 302 redirect', async () => {
      const { app, access } = createSecuredApp();
      access.beginTunnelSession();
      const issued = access.issueToken();
      expect(issued).not.toBeNull();

      const res = await app.request(`/?${TUNNEL_TOKEN_QUERY_PARAM}=${issued!.token}`);
      expect(res.status).toBe(302);
      const location = res.headers.get('Location');
      expect(location).toBe('/');
      expect(location).not.toContain(TUNNEL_TOKEN_QUERY_PARAM);
      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).not.toBeNull();
      expect(setCookie).toContain(`${TUNNEL_SESSION_COOKIE}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/');
    });

    it('allows access with session cookie without Authorization header', async () => {
      const { app, access } = createSecuredApp();
      access.beginTunnelSession();
      const issued = access.issueToken();
      const consumed = access.consumeToken(issued!.token);
      expect(consumed).not.toBeNull();

      const res = await app.request('/', {
        headers: {
          Cookie: `${TUNNEL_SESSION_COOKIE}=${consumed!.sessionId}`,
        },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    });

    it('returns 401 without cookie or Authorization', async () => {
      const { app, access } = createSecuredApp();
      access.beginTunnelSession();

      const res = await app.request('/');
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toContain('Basic realm="bdboard"');
    });

    it('returns 401 for invalid token without Set-Cookie', async () => {
      const { app, access } = createSecuredApp();
      access.beginTunnelSession();

      const res = await app.request(`/?${TUNNEL_TOKEN_QUERY_PARAM}=example-token`);
      expect(res.status).toBe(401);
      expect(res.headers.get('Set-Cookie')).toBeNull();
    });

    it('invalidates cookie after tunnel session ends', async () => {
      const { app, access } = createSecuredApp();
      access.beginTunnelSession();
      const issued = access.issueToken();
      const consumed = access.consumeToken(issued!.token);
      expect(consumed).not.toBeNull();

      access.endTunnelSession();

      const res = await app.request('/', {
        headers: {
          Cookie: `${TUNNEL_SESSION_COOKIE}=${consumed!.sessionId}`,
        },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('clickjacking protection headers (bdboard-3tw.137 review MAJOR-A)', () => {
    // Local direct access no longer requires Basic Auth (bdboard-3tw.137), so an
    // external site could <iframe> the board and attempt UI-redress attacks
    // (e.g. tricking a click into publishing a tunnel). These headers must be
    // present on every response, including 401s, so the auth prompt itself
    // can't be framed either.
    function createSecuredApp(authMode: Parameters<typeof mountSecurityMiddleware>[1]['authMode']) {
      const app = new Hono();
      mountSecurityMiddleware(app, { authMode });
      app.get('/', (c) => c.text('ok', 200));
      return app;
    }

    it('sets X-Frame-Options and CSP frame-ancestors on a successful response', async () => {
      const app = createSecuredApp({ kind: 'unconfigured' });

      const res = await app.request('/', { headers: { Host: 'localhost:8787' } }, LOCAL_ENV);
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    });

    it('sets the headers on a 401 (unauthenticated) response too', async () => {
      const app = createSecuredApp({
        kind: 'enabled',
        config: { username: USER, password: PASSWORD },
      });

      const res = await app.request('/', {}, REMOTE_ENV);
      expect(res.status).toBe(401);
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    });
  });

  describe('local Basic auth bypass via isLocalControlRequest', () => {
    function createSecuredApp(authMode: Parameters<typeof mountSecurityMiddleware>[1]['authMode']) {
      const app = new Hono();
      mountSecurityMiddleware(app, { authMode });
      app.get('/', (c) => c.text('ok', 200));
      return app;
    }

    it('allows loopback requests without Authorization in enabled mode', async () => {
      const app = createSecuredApp({
        kind: 'enabled',
        config: { username: USER, password: PASSWORD },
      });

      const res = await app.request(
        '/',
        { headers: { Host: 'localhost:8787' } },
        LOCAL_ENV,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    });

    it('allows loopback requests without Authorization in unconfigured mode', async () => {
      const app = createSecuredApp({ kind: 'unconfigured' });

      const res = await app.request(
        '/',
        { headers: { Host: '127.0.0.1:8787' } },
        LOCAL_ENV,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    });

    it('requires auth for loopback requests with Cloudflare tunnel headers', async () => {
      const app = createSecuredApp({
        kind: 'enabled',
        config: { username: USER, password: PASSWORD },
      });

      const res = await app.request(
        '/',
        {
          headers: {
            Host: 'localhost:8787',
            'cf-connecting-ip': '203.0.113.1',
          },
        },
        LOCAL_ENV,
      );
      expect(res.status).toBe(401);
    });

    it('returns 503 for loopback tunnel requests when auth is unconfigured', async () => {
      const app = createSecuredApp({ kind: 'unconfigured' });

      const res = await app.request(
        '/',
        { headers: { Host: 'localhost:8787', 'cf-ray': 'example-ray' } },
        LOCAL_ENV,
      );
      expect(res.status).toBe(503);
    });

    it('requires auth for non-loopback requests regardless of Cloudflare headers', async () => {
      const app = createSecuredApp({
        kind: 'enabled',
        config: { username: USER, password: PASSWORD },
      });

      const withoutCf = await app.request('/', {}, REMOTE_ENV);
      expect(withoutCf.status).toBe(401);

      const withCf = await app.request(
        '/',
        { headers: { 'cf-connecting-ip': '203.0.113.1' } },
        REMOTE_ENV,
      );
      expect(withCf.status).toBe(401);
    });

    it('requires auth when Host is not a local allowlisted host', async () => {
      const app = createSecuredApp({ kind: 'unconfigured' });

      const rebindingHost = await app.request(
        '/',
        { headers: { Host: 'attacker.example:8787' } },
        LOCAL_ENV,
      );
      expect(rebindingHost.status).toBe(503);

      const wrongPort = await app.request(
        '/',
        { headers: { Host: 'localhost:5173' } },
        LOCAL_ENV,
      );
      expect(wrongPort.status).toBe(503);
    });
  });
});
