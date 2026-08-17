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

function basicAuthHeader(user: string, pass: string): string {
  const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
  return `Basic ${encoded}`;
}

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

    expect(handlers.length).toBe(2);

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

    await handlers[0](firstContext as never, async () => {
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

    const status = await handlers[1](unauthorizedContext as never, async () => {
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
});
