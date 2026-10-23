import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import {
  createTunnelTokenExchangeMiddleware,
  readSessionCookie,
  TUNNEL_SESSION_COOKIE,
  TUNNEL_TOKEN_QUERY_PARAM,
} from './tunnel-session.js';
import { createTunnelAccessService } from '../../application/tunnel/tunnel-access.js';

describe('readSessionCookie', () => {
  it('extracts the tunnel session cookie from a multi-cookie header', () => {
    const value = readSessionCookie(
      `a=1; ${TUNNEL_SESSION_COOKIE}=example-session-id; b=2`,
    );
    expect(value).toBe('example-session-id');
  });

  it('returns null when the cookie is absent', () => {
    expect(readSessionCookie('a=1; b=2')).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
  });
});

describe('createTunnelTokenExchangeMiddleware', () => {
  it('does not redirect on POST even when t is present', async () => {
    const access = createTunnelAccessService({ now: () => new Date() });
    access.beginTunnelSession();
    const issued = access.issueToken();

    const middleware = createTunnelTokenExchangeMiddleware({
      access,
      secureCookie: false,
    });

    let nextCalled = false;
    const c = {
      req: {
        method: 'POST',
        query: (name: string) => (name === TUNNEL_TOKEN_QUERY_PARAM ? issued!.token : undefined),
        url: `http://localhost/?${TUNNEL_TOKEN_QUERY_PARAM}=${issued!.token}`,
        header: () => undefined,
      },
      header: () => {},
      redirect: () => {},
    } as unknown as Context;

    await middleware(c, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it('redirects with Set-Cookie on valid GET token', async () => {
    const access = createTunnelAccessService({ now: () => new Date() });
    access.beginTunnelSession();
    const issued = access.issueToken();

    const middleware = createTunnelTokenExchangeMiddleware({
      access,
      secureCookie: true,
    });

    const headers: Record<string, string> = {};
    let redirectStatus: number | undefined;
    let redirectLocation: string | undefined;

    const c = {
      req: {
        method: 'GET',
        query: (name: string) => (name === TUNNEL_TOKEN_QUERY_PARAM ? issued!.token : undefined),
        url: `http://localhost/?${TUNNEL_TOKEN_QUERY_PARAM}=${issued!.token}`,
        header: () => undefined,
      },
      header: (name: string, value: string) => {
        headers[name] = value;
      },
      redirect: (location: string, status: number) => {
        redirectLocation = location;
        redirectStatus = status;
        return { status, location };
      },
    } as unknown as Context;

    let nextCalled = false;
    await middleware(c, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(redirectStatus).toBe(302);
    expect(redirectLocation).toBe('/');
    expect(redirectLocation).not.toContain(TUNNEL_TOKEN_QUERY_PARAM);
    expect(headers['Set-Cookie']).toContain(`${TUNNEL_SESSION_COOKIE}=`);
    expect(headers['Set-Cookie']).toContain('HttpOnly');
    expect(headers['Set-Cookie']).toContain('Secure');
    expect(headers['Set-Cookie']).toContain('SameSite=Lax');
    expect(headers['Set-Cookie']).toContain('Path=/');
  });

  it('keeps the projects param (bdboard-u8p9) byte-for-byte while stripping t', async () => {
    const access = createTunnelAccessService({ now: () => new Date() });
    access.beginTunnelSession();
    const issued = access.issueToken();
    const middleware = createTunnelTokenExchangeMiddleware({ access, secureCookie: false });

    let redirectLocation: string | undefined;
    const projects = 'projects=%2FUsers%2Fa%2Cb,%2Fp%2Fc';
    const c = {
      req: {
        method: 'GET',
        query: (name: string) => (name === TUNNEL_TOKEN_QUERY_PARAM ? issued!.token : undefined),
        url: `http://localhost/?${TUNNEL_TOKEN_QUERY_PARAM}=${issued!.token}&${projects}&x=1`,
        header: () => undefined,
      },
      header: () => {},
      redirect: (location: string) => {
        redirectLocation = location;
        return { location };
      },
    } as unknown as Context;

    await middleware(c, async () => {});

    expect(redirectLocation).toBe(`/?${projects}&x=1`);
  });

  it('collapses a leading double slash so the redirect cannot leave the origin', async () => {
    const access = createTunnelAccessService({ now: () => new Date() });
    access.beginTunnelSession();
    const issued = access.issueToken();

    const middleware = createTunnelTokenExchangeMiddleware({
      access,
      secureCookie: false,
    });

    let redirectLocation: string | undefined;
    const c = {
      req: {
        method: 'GET',
        query: (name: string) => (name === TUNNEL_TOKEN_QUERY_PARAM ? issued!.token : undefined),
        url: `http://localhost//attacker.example/?${TUNNEL_TOKEN_QUERY_PARAM}=${issued!.token}`,
        header: () => undefined,
      },
      header: () => {},
      redirect: (location: string) => {
        redirectLocation = location;
        return { location };
      },
    } as unknown as Context;

    await middleware(c, async () => {});

    // "//attacker.example/" のままだとスキーム相対URLとして外部へ飛ぶ
    expect(redirectLocation).toBe('/attacker.example/');
    expect(redirectLocation?.startsWith('//')).toBe(false);
  });

  it('does not consume the token on HEAD (link prefetch must not burn it)', async () => {
    const access = createTunnelAccessService({ now: () => new Date() });
    access.beginTunnelSession();
    const issued = access.issueToken();

    const middleware = createTunnelTokenExchangeMiddleware({
      access,
      secureCookie: false,
    });

    let nextCalled = false;
    const c = {
      req: {
        method: 'HEAD',
        query: (name: string) => (name === TUNNEL_TOKEN_QUERY_PARAM ? issued!.token : undefined),
        url: `http://localhost/?${TUNNEL_TOKEN_QUERY_PARAM}=${issued!.token}`,
        header: () => undefined,
      },
      header: () => {},
      redirect: () => {},
    } as unknown as Context;

    await middleware(c, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    // トークンは未消費のまま残り、後続の本物の GET で使える
    expect(access.consumeToken(issued!.token)).not.toBeNull();
  });
});
