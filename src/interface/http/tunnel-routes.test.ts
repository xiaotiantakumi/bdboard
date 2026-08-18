import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { TunnelAccessService } from '../../application/tunnel/tunnel-access.js';
import type { TunnelService, TunnelState } from '../../application/tunnel/tunnel-service.js';
import { createTunnelRoutes } from './tunnel-routes.js';
import { createWriteGuardMiddleware } from './write-guard.js';

const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
    },
  },
};

// Placeholder-shaped on purpose: a realistic-looking literal assigned to
// adjacent `username`/`password` fields is exactly what GitGuardian's
// Username Password detector fires on, fake or not (see CLAUDE.md).
const ON_TUNNEL_STATE: TunnelState = {
  kind: 'on',
  url: 'https://x.trycloudflare.com',
  username: 'example-user',
  password: 'example-password',
  startedAt: new Date('2026-08-14T12:00:00.000Z'),
};

const OFF_TUNNEL_STATE: TunnelState = { kind: 'off' };

function createFakeTunnelService(
  overrides: Partial<TunnelService> = {},
): TunnelService {
  return {
    start: vi
      .fn<(options?: { readonly password?: string }) => Promise<TunnelState>>()
      .mockResolvedValue(ON_TUNNEL_STATE),
    stop: vi.fn<() => Promise<TunnelState>>().mockResolvedValue(OFF_TUNNEL_STATE),
    shutdown: vi.fn<() => Promise<TunnelState>>().mockResolvedValue(OFF_TUNNEL_STATE),
    getState: vi.fn((): TunnelState => OFF_TUNNEL_STATE),
    getCredentials: vi.fn(() => null),
    isWriteAllowed: vi.fn(() => false),
    getAvailability: vi.fn(() => true),
    probeAvailability: vi.fn(async () => true),
    getInterruptedAt: vi.fn(() => null),
    dismissInterruption: vi.fn(),
    ...overrides,
  };
}

function createApp(
  service: TunnelService,
  access?: TunnelAccessService,
  authEnabled = true,
): Hono {
  return createTunnelRoutes({
    tunnelService: service,
    authEnabled,
    ...(access !== undefined ? { access } : {}),
  });
}

describe('createTunnelRoutes local-only guard', () => {
  it('allows loopback without Cloudflare headers', async () => {
    const service = createFakeTunnelService();
    const app = createApp(service);

    const res = await app.request('/api/tunnel', {}, LOCAL_ENV);
    expect(res.status).toBe(200);
  });

  it('returns 403 for loopback with CF-Ray header', async () => {
    const service = createFakeTunnelService();
    const app = createApp(service);

    const res = await app.request(
      '/api/tunnel',
      { headers: { 'CF-Ray': 'abc123' } },
      LOCAL_ENV,
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for non-loopback remote address', async () => {
    const service = createFakeTunnelService();
    const app = createApp(service);

    const res = await app.request(
      '/api/tunnel',
      {},
      {
        incoming: {
          socket: {
            remoteAddress: '203.0.113.5',
          },
        },
      },
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when remote address cannot be determined', async () => {
    const service = createFakeTunnelService();
    const app = createApp(service);

    const res = await app.request('/api/tunnel', {}, {});
    expect(res.status).toBe(403);
  });

  it('guards start and stop as well as the collection path', async () => {
    for (const path of ['/api/tunnel', '/api/tunnel/start', '/api/tunnel/stop']) {
      const res = await createApp(createFakeTunnelService()).request(
        path,
        { method: path === '/api/tunnel' ? 'GET' : 'POST' },
        { incoming: { socket: { remoteAddress: '203.0.113.5' } } },
      );
      expect(res.status, `${path} must be guarded`).toBe(403);
    }
  });

  it('guards tunnel sub-paths that no route handles yet', async () => {
    // The guard matches by prefix, so an endpoint added under /api/tunnel later
    // is protected before its handler exists. Listing paths individually would
    // ship the next endpoint unguarded.
    const app = createApp(createFakeTunnelService());

    const res = await app.request(
      '/api/tunnel/some-future-endpoint',
      { method: 'POST' },
      { incoming: { socket: { remoteAddress: '203.0.113.5' } } },
    );
    expect(res.status).toBe(403);
  });
});

describe('createTunnelRoutes behavior', () => {
  it('does not return password when state is off', async () => {
    const service = createFakeTunnelService({
      getState: () => ({ kind: 'off' }),
      getAvailability: () => true,
    });
    const app = createApp(service);

    const res = await app.request('/api/tunnel', {}, LOCAL_ENV);
    const body = await res.json();

    expect(body).toEqual({ state: 'off', available: true, authEnabled: true });
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('username');
  });

  it('returns 400 when start password is too short', async () => {
    const service = createFakeTunnelService();
    const app = createApp(service);

    const res = await app.request(
      '/api/tunnel/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'a' }),
      },
      LOCAL_ENV,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'password must be 2-64 characters (the tunnel URL is public)',
    });
  });

  it('calls start on POST /api/tunnel/start', async () => {
    const start = vi.fn(async () => ({
      kind: 'on' as const,
      url: 'https://x.trycloudflare.com',
      username: 'example-user',
      password: 'example-password',
      startedAt: new Date('2026-08-14T12:00:00.000Z'),
    }));
    const service = createFakeTunnelService({ start });
    const app = createApp(service);

    const res = await app.request(
      '/api/tunnel/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'example-password' }),
      },
      LOCAL_ENV,
    );

    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalledWith({ password: 'example-password' });
  });

  it('reports disabled auth and refuses to start a public tunnel', async () => {
    const start = vi.fn(async (): Promise<TunnelState> => ON_TUNNEL_STATE);
    const service = createFakeTunnelService({ start });
    const app = createApp(service, undefined, false);

    const stateRes = await app.request('/api/tunnel', {}, LOCAL_ENV);
    expect(await stateRes.json()).toEqual({
      state: 'off',
      available: true,
      authEnabled: false,
    });

    const startRes = await app.request(
      '/api/tunnel/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      LOCAL_ENV,
    );
    expect(startRes.status).toBe(409);
    expect(await startRes.json()).toEqual({
      error: 'Basic Auth must be enabled before starting a tunnel',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('calls stop on POST /api/tunnel/stop', async () => {
    const stop = vi.fn(async () => ({ kind: 'off' as const }));
    const service = createFakeTunnelService({ stop });
    const app = createApp(service);

    const res = await app.request(
      '/api/tunnel/stop',
      { method: 'POST' },
      LOCAL_ENV,
    );

    expect(res.status).toBe(200);
    expect(stop).toHaveBeenCalled();
  });

  it('returns unavailable when service is not available', async () => {
    const start = vi.fn(async () => ({ kind: 'unavailable' as const }));
    const service = createFakeTunnelService({
      start,
      getAvailability: () => false,
    });
    const app = createApp(service);

    const res = await app.request(
      '/api/tunnel/start',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      LOCAL_ENV,
    );

    const body = await res.json();
    expect(body).toEqual({
      state: 'unavailable',
      available: false,
      authEnabled: true,
    });
  });
});

// bdboard-3tw.137 レビュー MAJOR-B: tunnel-routes.ts の localOnlyGuard は
// loopback かどうかしか見ておらず、CSRF ヘッダ(sec-fetch-site/Origin)は
// 一切見ていない。実際の CSRF 防御は main.ts が write-guard を先に
// app.route('/', inner) で mount し、tunnel-routes を後から別の
// app.route('/', ...) で mount する、という並び順だけに依存した暗黙の
// 副作用で成立している(Hono の route() 合成の詳細に依存)。ここではその
// 並び順を最小構成で再現し、外部サイトからのクロスサイト POST が
// (loopbackアドレス由来であっても)write-guard の CSRF レイヤで実際に
// 403 で止まることを固定する。将来 main.ts の mount 順が変わったり
// tunnel-routes 単体に切り出されたりして、この暗黙の防御が失われたら
// このテストが落ちる。
describe('CSRF protection reaches tunnel routes via main.ts mount order (regression)', () => {
  function createComposedApp(service: TunnelService): Hono {
    const app = new Hono();
    // main.ts と同じ構造: write-guard は「inner」という別のサブアプリに
    // mount され、app.route('/', inner) で親へ合成される。tunnel-routes は
    // その後、別個の app.route('/', ...) 呼び出しで合成される。
    const inner = new Hono();
    inner.use('*', createWriteGuardMiddleware({}));
    app.route('/', inner);
    app.route('/', createTunnelRoutes({ tunnelService: service, authEnabled: true }));
    return app;
  }

  it('blocks a cross-site POST to /api/tunnel/start even from a loopback address', async () => {
    const start = vi.fn();
    const service = createFakeTunnelService({ start });
    const app = createComposedApp(service);

    // remoteAddress がループバックで CF ヘッダも無いので localOnlyGuard 単体
    // なら通す組み合わせ。sec-fetch-site: cross-site だけが攻撃者ページ発の
    // リクエストであることを示す — これがブロックされて初めて write-guard の
    // CSRF レイヤが tunnel-routes まで届いていると言える。
    const res = await app.request(
      '/api/tunnel/start',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'sec-fetch-site': 'cross-site',
        },
        body: JSON.stringify({}),
      },
      LOCAL_ENV,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross-site write blocked' });
    expect(start).not.toHaveBeenCalled();
  });

  it('allows a same-origin loopback POST to reach the tunnel handler', async () => {
    const start = vi.fn(async () => ON_TUNNEL_STATE);
    const service = createFakeTunnelService({ start });
    const app = createComposedApp(service);

    const res = await app.request(
      '/api/tunnel/start',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ password: 'example-password' }),
      },
      LOCAL_ENV,
    );

    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalledWith({ password: 'example-password' });
  });
});

describe('POST /api/tunnel/access-token', () => {
  function createAccessMock(
    overrides: Partial<TunnelAccessService> = {},
  ): TunnelAccessService {
    return {
      beginTunnelSession: vi.fn(),
      endTunnelSession: vi.fn(),
      issueToken: vi.fn(() => ({
        token: 'example-token-value',
        expiresAt: new Date('2026-08-15T12:00:00.000Z'),
      })),
      consumeToken: vi.fn(() => null),
      isValidSession: vi.fn(() => false),
      ...overrides,
    };
  }

  it('returns 409 when tunnel is off', async () => {
    const service = createFakeTunnelService({ getState: () => ({ kind: 'off' }) });
    const access = createAccessMock();
    const app = createApp(service, access);

    const res = await app.request(
      '/api/tunnel/access-token',
      { method: 'POST' },
      LOCAL_ENV,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'tunnel is not running' });
  });

  it('returns token when tunnel is on and omits secrets from GET /api/tunnel', async () => {
    const service = createFakeTunnelService({ getState: () => ON_TUNNEL_STATE });
    const access = createAccessMock();
    const app = createApp(service, access);

    const tokenRes = await app.request(
      '/api/tunnel/access-token',
      { method: 'POST' },
      LOCAL_ENV,
    );
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json();
    expect(tokenBody).toEqual({
      token: 'example-token-value',
      expiresAt: '2026-08-15T12:00:00.000Z',
    });

    const stateRes = await app.request('/api/tunnel', {}, LOCAL_ENV);
    const stateBody = await stateRes.json();
    expect(stateBody).not.toHaveProperty('token');
    expect(stateBody).not.toHaveProperty('password');
    expect(stateBody).not.toHaveProperty('username');
  });

  it('returns 403 when requested through tunnel (CF-Ray)', async () => {
    const service = createFakeTunnelService({ getState: () => ON_TUNNEL_STATE });
    const access = createAccessMock();
    const app = createApp(service, access);

    const res = await app.request(
      '/api/tunnel/access-token',
      { method: 'POST', headers: { 'CF-Ray': 'abc123' } },
      LOCAL_ENV,
    );
    expect(res.status).toBe(403);
  });
});

// bdboard-9rz: 書き込みが開いているかを状態として返す。短いパスワードで起動した
// トンネルはここが false になり、UI が「読み取り専用」を説明できる。
describe('write access in the tunnel state DTO', () => {
  it('reports writeAccess: true when the service allows tunnel writes', async () => {
    const service = createFakeTunnelService({
      getState: vi.fn((): TunnelState => ON_TUNNEL_STATE),
      isWriteAllowed: vi.fn(() => true),
    });
    const app = createApp(service);

    const res = await app.request('/api/tunnel', {}, LOCAL_ENV);
    const body = await res.json();

    expect(body.writeAccess).toBe(true);
  });

  it('reports writeAccess: false when the tunnel password is too short', async () => {
    const service = createFakeTunnelService({
      getState: vi.fn((): TunnelState => ON_TUNNEL_STATE),
      isWriteAllowed: vi.fn(() => false),
    });
    const app = createApp(service);

    const res = await app.request('/api/tunnel', {}, LOCAL_ENV);
    const body = await res.json();

    expect(body.writeAccess).toBe(false);
  });

  it('omits writeAccess when the tunnel is off', async () => {
    const app = createApp(createFakeTunnelService());

    const res = await app.request('/api/tunnel', {}, LOCAL_ENV);
    const body = await res.json();

    expect(body).not.toHaveProperty('writeAccess');
  });
});

describe('tunnel interruption in the state DTO', () => {
  const interruptedAt = new Date('2026-08-15T03:00:00.000Z');

  it('includes interruptedAt on GET when a record exists', async () => {
    const service = createFakeTunnelService({
      getInterruptedAt: vi.fn(() => interruptedAt),
    });
    const app = createApp(service);

    const res = await app.request('/api/tunnel', {}, LOCAL_ENV);
    const body = await res.json();

    expect(body.interruptedAt).toBe(interruptedAt.toISOString());
  });

  it('omits interruptedAt on GET when no record exists', async () => {
    const app = createApp(createFakeTunnelService());

    const res = await app.request('/api/tunnel', {}, LOCAL_ENV);
    const body = await res.json();

    expect(body).not.toHaveProperty('interruptedAt');
  });

  it('omits interruptedAt on GET while the tunnel is on even if a record exists', async () => {
    const service = createFakeTunnelService({
      getState: vi.fn((): TunnelState => ON_TUNNEL_STATE),
      getInterruptedAt: vi.fn(() => interruptedAt),
    });
    const app = createApp(service);

    const res = await app.request('/api/tunnel', {}, LOCAL_ENV);
    const body = await res.json();

    expect(body).not.toHaveProperty('interruptedAt');
  });

  it('clears the interruption on POST /api/tunnel/interruption/dismiss', async () => {
    const dismissInterruption = vi.fn();
    let storedInterruptedAt: Date | null = interruptedAt;
    const service = createFakeTunnelService({
      getInterruptedAt: vi.fn(() => storedInterruptedAt),
      dismissInterruption: () => {
        dismissInterruption();
        storedInterruptedAt = null;
      },
    });
    const app = createApp(service);

    const dismissRes = await app.request(
      '/api/tunnel/interruption/dismiss',
      { method: 'POST' },
      LOCAL_ENV,
    );
    expect(dismissRes.status).toBe(200);
    expect(dismissInterruption).toHaveBeenCalledOnce();
    expect(await dismissRes.json()).not.toHaveProperty('interruptedAt');

    const getRes = await app.request('/api/tunnel', {}, LOCAL_ENV);
    expect(await getRes.json()).not.toHaveProperty('interruptedAt');
  });

  it('returns 403 for dismiss from a non-local request', async () => {
    const service = createFakeTunnelService();
    const app = createApp(service);

    const res = await app.request(
      '/api/tunnel/interruption/dismiss',
      { method: 'POST' },
      { incoming: { socket: { remoteAddress: '203.0.113.5' } } },
    );

    expect(res.status).toBe(403);
  });
});
