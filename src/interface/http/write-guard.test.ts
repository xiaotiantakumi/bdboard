import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  checkCsrf,
  createPrivilegedApiGuardMiddleware,
  createWriteGuardMiddleware,
  isMutatingMethod,
  type WriteGuardDeps,
} from './write-guard.js';

const LOCAL_HOST = 'localhost:8787';

const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
      localPort: 8787,
    },
  },
};

/** cloudflared はローカルへ 127.0.0.1 から繋ぐので、トンネル経由の擬似リクエストは
 *  「ループバック remoteAddress + Cloudflare の転送ヘッダ」で表現する
 *  (tunnel-routes.test.ts と同じ手法)。 */
const TUNNEL_ENV = LOCAL_ENV;
const CF_HEADER = { 'CF-Ray': 'abc123-NRT' } as const;
const JSON_HEADER = { 'Content-Type': 'application/json' } as const;
const SESSION_COOKIE = 'bdboard_tunnel_session=example-session-value';

function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}

function createApp(deps: WriteGuardDeps = {}): Hono {
  const app = new Hono();
  app.use('*', createWriteGuardMiddleware(deps));
  app.post('/api/write', (c) => c.json({ ok: true }));
  app.delete('/api/write', (c) => c.json({ ok: true }));
  app.get('/api/read', (c) => c.json({ ok: true }));
  return app;
}

function allowingDeps(overrides: Partial<WriteGuardDeps> = {}): WriteGuardDeps {
  return {
    isTunnelWriteAllowed: () => true,
    hasTunnelSession: () => true,
    ...overrides,
  };
}

describe('isMutatingMethod', () => {
  it('treats POST/PUT/PATCH/DELETE as mutating and reads as not', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'delete']) {
      expect(isMutatingMethod(method)).toBe(true);
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isMutatingMethod(method)).toBe(false);
    }
  });
});

describe('checkCsrf', () => {
  function headers(init: Record<string, string>): Headers {
    return new Headers(init);
  }

  it('accepts a same-origin JSON request', () => {
    expect(
      checkCsrf(
        headers({
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json; charset=utf-8',
        }),
      ),
    ).toBe(true);
  });

  it('rejects a cross-site request even when it looks like our own JSON call', () => {
    expect(
      checkCsrf(
        headers({
          'Sec-Fetch-Site': 'cross-site',
          'Content-Type': 'application/json',
        }),
      ),
    ).toBe(false);
  });

  // trycloudflare.com のような共有ドメインでは、別サブドメインの攻撃者ページが
  // same-site になりうるので same-site も許さない。
  it('rejects same-site as well as cross-site', () => {
    expect(
      checkCsrf(headers({ 'Sec-Fetch-Site': 'same-site', ...JSON_HEADER })),
    ).toBe(false);
  });

  it('rejects the three content types an HTML form can send', () => {
    for (const contentType of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain;charset=UTF-8',
    ]) {
      expect(checkCsrf(headers({ 'Content-Type': contentType }))).toBe(false);
    }
  });

  // Blob ボディの no-cors fetch は Content-Type を付けずに単純リクエストとして飛ばせる。
  // Content-Type 検査「だけ」だとここが素通りするので、ボディ有無でも塞ぐ。
  it('rejects a body sent without any Content-Type', () => {
    expect(checkCsrf(headers({ 'Content-Length': '42' }))).toBe(false);
    expect(checkCsrf(headers({ 'Transfer-Encoding': 'chunked' }))).toBe(false);
  });

  it('accepts a bodiless request with no Content-Type (e.g. DELETE)', () => {
    expect(checkCsrf(headers({}))).toBe(true);
    expect(checkCsrf(headers({ 'Content-Length': '0' }))).toBe(true);
  });

  // Sec-Fetch-Site を送らない古いブラウザ向けの保険レイヤ。
  it('falls back to an Origin/Host comparison when Fetch Metadata is absent', () => {
    expect(
      checkCsrf(
        headers({
          Origin: 'https://evil.example',
          Host: 'board.trycloudflare.com',
          ...JSON_HEADER,
        }),
      ),
    ).toBe(false);

    expect(
      checkCsrf(
        headers({
          Origin: 'https://board.trycloudflare.com',
          Host: 'board.trycloudflare.com',
          ...JSON_HEADER,
        }),
      ),
    ).toBe(true);
  });

  // cloudflared が Host を書き換えるケースで誤判定しないよう、Fetch Metadata が
  // あるときは Origin/Host 比較を見ない(そちらの方が確実なため)。
  it('ignores an Origin/Host mismatch when Sec-Fetch-Site says same-origin', () => {
    expect(
      checkCsrf(
        headers({
          'Sec-Fetch-Site': 'same-origin',
          Origin: 'https://board.trycloudflare.com',
          Host: 'localhost:8787',
          ...JSON_HEADER,
        }),
      ),
    ).toBe(true);
  });
});

describe('createWriteGuardMiddleware', () => {
  it('does not touch reads', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/read',
      { headers: { 'Sec-Fetch-Site': 'cross-site', ...CF_HEADER } },
      TUNNEL_ENV,
    );
    expect(res.status).toBe(200);
  });

  it('allows a local write', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/write',
      withLocalHost({ method: 'POST', headers: JSON_HEADER, body: '{}' }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(200);
  });

  it('blocks a cross-site local write (CSRF against localhost counts too)', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/write',
      withLocalHost({
        method: 'POST',
        headers: { 'Sec-Fetch-Site': 'cross-site', ...JSON_HEADER },
        body: '{}',
      }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross-site write blocked' });
  });

  it('allows a tunnel write when the password is strong and the session is valid', async () => {
    const app = createApp(allowingDeps());
    const res = await app.request(
      '/api/write',
      {
        method: 'POST',
        headers: { ...CF_HEADER, ...JSON_HEADER, Cookie: SESSION_COOKIE },
        body: '{}',
      },
      TUNNEL_ENV,
    );
    expect(res.status).toBe(200);
  });

  // AC(3): 短いパスワードのトンネルでは、セッション Cookie が有効でも書き込みは開かない。
  it('falls back to localhost-only when the tunnel password is too short', async () => {
    const isTunnelWriteAllowed = vi.fn(() => false);
    const hasTunnelSession = vi.fn(() => true);
    const app = createApp({ isTunnelWriteAllowed, hasTunnelSession });

    const res = await app.request(
      '/api/write',
      {
        method: 'POST',
        headers: { ...CF_HEADER, ...JSON_HEADER, Cookie: SESSION_COOKIE },
        body: '{}',
      },
      TUNNEL_ENV,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
    expect(isTunnelWriteAllowed).toHaveBeenCalled();
  });

  it('rejects a tunnel write with no session cookie even when the password is strong', async () => {
    const app = createApp(allowingDeps({ hasTunnelSession: () => false }));
    const res = await app.request(
      '/api/write',
      { method: 'POST', headers: { ...CF_HEADER, ...JSON_HEADER }, body: '{}' },
      TUNNEL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
  });

  it('rejects a cross-site tunnel write that carries a valid session cookie', async () => {
    const app = createApp(allowingDeps());
    const res = await app.request(
      '/api/write',
      {
        method: 'POST',
        headers: {
          ...CF_HEADER,
          ...JSON_HEADER,
          'Sec-Fetch-Site': 'cross-site',
          Cookie: SESSION_COOKIE,
        },
        body: '{}',
      },
      TUNNEL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross-site write blocked' });
  });

  // 依存が渡されないとき(トンネル未配線の組み立て)は従来どおり localhost 限定へ。
  it('is fail-closed when no tunnel write dependencies are supplied', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/write',
      {
        method: 'POST',
        headers: { ...CF_HEADER, ...JSON_HEADER, Cookie: SESSION_COOKIE },
        body: '{}',
      },
      TUNNEL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
  });

  it('guards a bodiless DELETE the same way', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/write',
      { method: 'DELETE', headers: CF_HEADER },
      TUNNEL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
  });
});

// bdboard-cu4: 副作用を持つ GET(チャットの availability など)にも同じ認可を掛けるための版。
describe('createPrivilegedApiGuardMiddleware', () => {
  function createGuardedApp(
    deps: WriteGuardDeps = {},
    messages?: { csrf?: string; notAuthorized?: string },
  ): Hono {
    const app = new Hono();
    app.use('*', createPrivilegedApiGuardMiddleware(deps, messages));
    app.get('/api/read', (c) => c.json({ ok: true }));
    app.post('/api/write', (c) => c.json({ ok: true }));
    return app;
  }

  it('guards reads as well as writes, unlike the write guard', async () => {
    const res = await createGuardedApp().request(
      '/api/read',
      { headers: CF_HEADER },
      TUNNEL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
  });

  it('still allows local reads', async () => {
    const res = await createGuardedApp().request('/api/read', withLocalHost({}), LOCAL_ENV);
    expect(res.status).toBe(200);
  });

  it('applies the same tunnel authorization as the write guard', async () => {
    const authorized = await createGuardedApp(allowingDeps()).request(
      '/api/read',
      { headers: { ...CF_HEADER, Cookie: SESSION_COOKIE } },
      TUNNEL_ENV,
    );
    expect(authorized.status).toBe(200);

    const weakPassword = await createGuardedApp(
      allowingDeps({ isTunnelWriteAllowed: () => false }),
    ).request(
      '/api/read',
      { headers: { ...CF_HEADER, Cookie: SESSION_COOKIE } },
      TUNNEL_ENV,
    );
    expect(weakPassword.status).toBe(403);
  });

  it('uses the supplied deny messages', async () => {
    const app = createGuardedApp(allowingDeps(), {
      csrf: 'cross-site chat request blocked',
      notAuthorized: 'chat needs a session',
    });

    const crossSite = await app.request(
      '/api/write',
      {
        method: 'POST',
        headers: { ...CF_HEADER, ...JSON_HEADER, 'Sec-Fetch-Site': 'cross-site' },
        body: '{}',
      },
      TUNNEL_ENV,
    );
    expect(await crossSite.json()).toEqual({
      error: 'cross-site chat request blocked',
    });

    const unauthorized = await createGuardedApp(
      allowingDeps({ hasTunnelSession: () => false }),
      { notAuthorized: 'chat needs a session' },
    ).request('/api/read', { headers: CF_HEADER }, TUNNEL_ENV);
    expect(await unauthorized.json()).toEqual({ error: 'chat needs a session' });
  });
});

describe('write guard DNS rebinding resistance', () => {
  it('does not treat loopback with a non-local Host as local write access', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/write',
      {
        method: 'POST',
        headers: {
          Host: 'attacker.example:8787',
          ...JSON_HEADER,
        },
        body: '{}',
      },
      LOCAL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
  });

  it('does not treat loopback with a wrong local port in Host as local privileged read access', async () => {
    const app = new Hono();
    app.use('*', createPrivilegedApiGuardMiddleware());
    app.get('/api/read', (c) => c.json({ ok: true }));

    const res = await app.request(
      '/api/read',
      { headers: { Host: 'localhost:5173' } },
      LOCAL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'local access only' });
  });
});
