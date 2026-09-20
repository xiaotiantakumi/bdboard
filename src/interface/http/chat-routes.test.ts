import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ChatAgentPort } from '../../application/ports/chat-agent.js';
import type { ChatSessionDiscoveryPort } from '../../application/ports/chat-session-discovery.js';
import { createChatAgentRegistry } from '../../application/chat/chat-agent-registry.js';
import {
  CHAT_CSRF_DENIED,
  CHAT_NOT_AUTHORIZED,
  CHAT_SESSION_DISCOVERY_LOCAL_ONLY,
} from './chat-routes.js';
import { CHAT_RATE_LIMITED } from './chat-rate-limit.js';
import type { WriteGuardDeps } from './write-guard.js';
import {
  LOCAL_ENV,
  NOW,
  cachedProject,
  createApp,
  createFakeAgent,
  createFakeBoardCache,
  project,
  withLocalHost,
} from './chat-routes-test-support.js';

// bdboard-sso1.31: chat-routes.test.ts (chat ルート総合テスト) を実装側の chat
// ルートモジュール分割 (bdboard-sso1.17) に追随させて move-only 分割している途中
// (2/3)。このPRでは 'detached bulk chat turn recovery' / 'createChatRoutes
// behavior' (POST /api/chat/message の bulk 送信・sessionId/agentId/model
// バリデーション・永続化) を chat-message-routes.test.ts へ、'chat sessionId
// validation and agentId' describe のうち GET /api/chat/sessions/:id/messages・
// GET /api/chat/threads・PATCH .../thread・DELETE /api/chat/sessions/:id を
// chat-thread-routes.test.ts へ抽出した。CHAT_ROUTES_SOURCE の定義も
// '.uuid()' チェックのテストと一緒に chat-message-routes.test.ts へ移した。
// 残りのテスト本体・期待値・モックの記述は元の chat-routes.test.ts から一字一句
// 変更していない。discovered-sessions 系 (元 'chat sessionId validation and
// agentId' describe の残り) と DNS rebinding 系は chat-routes.test.ts に残し、
// 後続PR (bdboard-sso1.31-c) で分割する。
describe('createChatRoutes local-only guard', () => {
  it('allows loopback without Cloudflare headers', async () => {
    const app = createApp();

    const res = await app.request('/api/chat/availability', withLocalHost({}), LOCAL_ENV);
    expect(res.status).toBe(200);
  });

  it('returns 403 for loopback with CF-Ray header', async () => {
    const app = createApp();

    const res = await app.request(
      '/api/chat/availability',
      withLocalHost({ headers: { 'CF-Ray': 'abc123' } }),
      LOCAL_ENV,
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for loopback with a non-local Host header', async () => {
    const app = createApp();

    const res = await app.request(
      '/api/chat/availability',
      { headers: { Host: 'attacker.example:8787' } },
      LOCAL_ENV,
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for non-loopback remote address', async () => {
    const app = createApp();

    const res = await app.request(
      '/api/chat/availability',
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
    const app = createApp();

    const res = await app.request('/api/chat/availability', {}, {});
    expect(res.status).toBe(403);
  });

  it('does not leak detail in the 403 body for availability', async () => {
    const app = createApp();

    const res = await app.request(
      '/api/chat/availability',
      {},
      { incoming: { socket: { remoteAddress: '203.0.113.5' } } },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: CHAT_NOT_AUTHORIZED });
    expect(body).not.toHaveProperty('detail');
  });

  it('guards availability and message endpoints', async () => {
    for (const path of ['/api/chat/availability', '/api/chat/message', '/api/chat/message/stream']) {
      const isGet = path === '/api/chat/availability';
      const res = await createApp().request(
        path,
        isGet
          ? { method: 'GET' }
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
            },
        { incoming: { socket: { remoteAddress: '203.0.113.5' } } },
      );
      expect(res.status, `${path} must be guarded`).toBe(403);
    }
  });

  it('guards chat sub-paths that no route handles yet', async () => {
    const app = createApp();

    const res = await app.request(
      '/api/chat/some-future-endpoint',
      { method: 'POST' },
      { incoming: { socket: { remoteAddress: '203.0.113.5' } } },
    );
    expect(res.status).toBe(403);
  });
});

// bdboard-9rz はチャットをトンネルから完全に遮断し、それを 3 件の退行テストで固定していた。
// bdboard-cu4 でユーザーが「スマホでもローカルと同じことをできるように」と判断を上書きしたので、
// テストは削除せず「9rz と同じ認可条件を満たすときだけ通る」へ書き換える。
// 固定したい性質は 2 つとも維持する:
//   (a) 弱いパスワード or セッション無しなら従来どおり拒否
//   (b) 未実装のサブパスも前方一致で守られる(次に足すチャットのエンドポイントが無防備にならない)
// トンネル経由の判別はテスト全体と同じく CF-Ray ヘッダ + ループバック remoteAddress の
// 擬似リクエストで行う(cloudflared はローカルへ 127.0.0.1 から繋ぐため)。
describe('chat over the tunnel uses the same authorization as writes (bdboard-cu4)', () => {
  const TUNNEL_HEADERS = {
    'CF-Ray': 'abc123-NRT',
    Cookie: 'bdboard_tunnel_session=example-session-value',
    'Content-Type': 'application/json',
  } as const;

  /** 9rz の書き込み開放と同じ条件が揃った状態 */
  function authorizedDeps(
    overrides: Partial<WriteGuardDeps> = {},
  ): WriteGuardDeps {
    return {
      isTunnelWriteAllowed: () => true,
      hasTunnelSession: () => true,
      ...overrides,
    };
  }

  function silentAgent(
    models: readonly { readonly id: string; readonly label: string; readonly weight?: number }[] = [
      { id: 'sonnet', label: 'Sonnet' },
    ],
  ): ChatAgentPort {
    return {
      descriptor: {
        id: 'test-agent',
        label: 'Test Agent',
        models,
        experimental: false,
        capability: 'bd-only',
      },
      checkAvailability: vi.fn(async () => 'available' as const),
      sendMessage: vi.fn(async () => ({
        reply: 'hello from agent',
        sessionId: '550e8400-e29b-41d4-a716-446655440099',
        failedTools: [],
        agentId: 'test-agent',
      })),
    };
  }

  it('allows POST /api/chat/message through the tunnel with a strong password and a session', async () => {
    const agent = silentAgent([{ id: 'opus', label: 'Opus' }]);
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({ agent, cache, writeAccess: authorizedDeps() });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: TUNNEL_HEADERS,
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(200);
    expect(agent.sendMessage).toHaveBeenCalled();
  });

  it('allows a non-bd-only capability agent to be selected and used through the tunnel (bdboard-l1t.4 / bdboard-9a9)', async () => {
    const nonBdOnlyAgent: ChatAgentPort = {
      descriptor: { id: 'codex', label: 'Codex CLI', experimental: true, capability: 'unrestricted' },
      checkAvailability: vi.fn(async () => 'available' as const),
      sendMessage: vi.fn(async () => ({ reply: 'hello from codex', sessionId: '550e8400-e29b-41d4-a716-446655440098', failedTools: [], agentId: 'codex' })),
    };
    const registry = createChatAgentRegistry();
    registry.register(silentAgent());
    registry.register(nonBdOnlyAgent);
    const cache = createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]);
    const app = createApp({ agents: registry, cache, writeAccess: authorizedDeps() });
    const res = await app.request('/api/chat/message', withLocalHost({
      method: 'POST',
      headers: TUNNEL_HEADERS,
      body: JSON.stringify({ projectId: 'proj-a', message: 'hi', agentId: 'codex' }),
    }), LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(nonBdOnlyAgent.sendMessage).toHaveBeenCalled();
  });

  // GET はメソッド判定型の write-guard には引っかからない。availability は claude CLI を
  // 起動する副作用付きの GET なので、書き込みと同じ資格を要求できていることを固定する。
  it('allows GET /api/chat/availability through the tunnel with a strong password and a session', async () => {
    const agent = silentAgent();
    const app = createApp({ agent, writeAccess: authorizedDeps() });

    const res = await app.request(
      '/api/chat/availability',
      withLocalHost({ headers: { 'CF-Ray': 'abc123-NRT', Cookie: TUNNEL_HEADERS.Cookie } }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ availability: 'available' });
    expect(agent.checkAvailability).toHaveBeenCalled();
  });

  it('rejects POST /api/chat/message through the tunnel when the password is too weak', async () => {
    const agent = silentAgent();
    const app = createApp({
      agent,
      writeAccess: authorizedDeps({ isTunnelWriteAllowed: () => false }),
    });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: TUNNEL_HEADERS,
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CHAT_NOT_AUTHORIZED });
    expect(agent.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects POST /api/chat/message through the tunnel without a session cookie', async () => {
    const agent = silentAgent();
    const app = createApp({
      agent,
      writeAccess: authorizedDeps({ hasTunnelSession: () => false }),
    });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'CF-Ray': 'abc123-NRT', 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CHAT_NOT_AUTHORIZED });
    expect(agent.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects GET /api/chat/availability through the tunnel when the password is too weak', async () => {
    const agent = silentAgent();
    const app = createApp({
      agent,
      writeAccess: authorizedDeps({ isTunnelWriteAllowed: () => false }),
    });

    const res = await app.request(
      '/api/chat/availability',
      withLocalHost({ headers: { 'CF-Ray': 'abc123-NRT', Cookie: TUNNEL_HEADERS.Cookie } }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CHAT_NOT_AUTHORIZED });
    expect(agent.checkAvailability).not.toHaveBeenCalled();
  });

  it('rejects GET /api/chat/availability through the tunnel without a session cookie', async () => {
    const agent = silentAgent();
    const app = createApp({
      agent,
      writeAccess: authorizedDeps({ hasTunnelSession: () => false }),
    });

    const res = await app.request(
      '/api/chat/availability',
      withLocalHost({ headers: { 'CF-Ray': 'abc123-NRT' } }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(403);
    expect(agent.checkAvailability).not.toHaveBeenCalled();
  });

  // CSRF: トンネル URL は公開されるので、チャットが開いた以上は外部サイトからの
  // クロスオリジン POST も現実的な脅威になる。書き込みと同じ 3 レイヤで弾く。
  it('rejects a cross-site chat request that carries a valid session cookie', async () => {
    const agent = silentAgent();
    const app = createApp({ agent, writeAccess: authorizedDeps() });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { ...TUNNEL_HEADERS, 'Sec-Fetch-Site': 'cross-site' },
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CHAT_CSRF_DENIED });
    expect(agent.sendMessage).not.toHaveBeenCalled();
  });

  // tunnel-routes.test.ts の「guards tunnel sub-paths that no route handles yet」と同じ発想。
  // ガードが前方一致で効いていることを固定するので、将来 /api/chat/ 配下に新しい
  // エンドポイントを足しても、ガードの掛け忘れで無防備に出荷されることはない。
  // GET と POST の両方を見るのは、cu4 でガードがメソッド判定を持たない版に変わったため。
  it('guards chat sub-paths that no route handles yet', async () => {
    // bdboard-3tw.104.3 レビュー SF7後半: 未実装の作り物パスだけでなく、実在する深い
    // 動的セグメント付きパス(discovered-sessions/adopt)も同じループで固定する。
    // '/api/chat/*' の前方一致が多段のネストしたパスでも効くことの回帰テスト。
    const deepAdoptPath = '/api/chat/projects/proj-a/discovered-sessions/session-1/adopt';
    for (const requestPath of ['/api/chat/not-implemented-yet', deepAdoptPath]) {
      for (const init of [
        { method: 'POST', headers: TUNNEL_HEADERS, body: '{}' },
        { method: 'GET', headers: { 'CF-Ray': 'abc123-NRT' } },
      ]) {
        const app = createApp({
          writeAccess: authorizedDeps({ isTunnelWriteAllowed: () => false }),
        });

        const res = await app.request(requestPath, withLocalHost(init), LOCAL_ENV);

        // 404 ではなく 403 = ハンドラ解決より前にガードが効いている。
        expect(res.status, `${init.method} ${requestPath} must be guarded`).toBe(403);
        expect(await res.json()).toEqual({ error: CHAT_NOT_AUTHORIZED });
      }
    }
  });

  // 上のテストが「未実装だから 404」ではなく「ガードで 403」であることの対照実験。
  // 認可が通れば同じパスは素通りしてルーティングに落ち、404 になる。
  it('lets an authorized request fall through to a genuine 404', async () => {
    const app = createApp({ writeAccess: authorizedDeps() });

    const res = await app.request(
      '/api/chat/not-implemented-yet',
      withLocalHost({ method: 'GET', headers: { 'CF-Ray': 'abc123-NRT' } }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(404);
  });
});

describe('chat tunnel rate limit (bdboard-b7n)', () => {
  const TUNNEL_HEADERS = {
    'CF-Ray': 'abc123-NRT',
    Cookie: 'bdboard_tunnel_session=example-session-value',
    'Content-Type': 'application/json',
  } as const;

  function authorizedDeps(
    overrides: Partial<WriteGuardDeps> = {},
  ): WriteGuardDeps {
    return {
      isTunnelWriteAllowed: () => true,
      hasTunnelSession: () => true,
      ...overrides,
    };
  }

  function silentAgent(
    models: readonly { readonly id: string; readonly label: string; readonly weight?: number }[] = [
      { id: 'sonnet', label: 'Sonnet' },
    ],
  ): ChatAgentPort {
    return {
      descriptor: {
        id: 'test-agent',
        label: 'Test Agent',
        models,
        experimental: false,
        capability: 'bd-only',
      },
      checkAvailability: vi.fn(async () => 'available' as const),
      sendMessage: vi.fn(async () => ({
        reply: 'hello from agent',
        sessionId: '550e8400-e29b-41d4-a716-446655440099',
        failedTools: [],
        agentId: 'test-agent',
      })),
    };
  }

  async function messageRequest(
    app: Hono,
    env: typeof LOCAL_ENV = LOCAL_ENV,
  ): Promise<Response> {
    return await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: TUNNEL_HEADERS,
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      env,
    );
  }

  async function streamMessageRequest(
    app: Hono,
    env: typeof LOCAL_ENV = LOCAL_ENV,
  ): Promise<Response> {
    return await app.request(
      '/api/chat/message/stream',
      withLocalHost({
        method: 'POST',
        headers: TUNNEL_HEADERS,
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      env,
    );
  }

  it('does not rate-limit localhost requests', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      cache,
      rateLimit: { perMinute: 2 },
    });

    for (let i = 0; i < 5; i += 1) {
      const res = await app.request(
        '/api/chat/message',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
        }),
        LOCAL_ENV,
      );
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 when tunnel requests exceed the per-minute limit', async () => {
    const agent = silentAgent();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      agent,
      cache,
      writeAccess: authorizedDeps(),
      rateLimit: { perMinute: 2 },
    });

    expect((await messageRequest(app)).status).toBe(200);
    expect((await messageRequest(app)).status).toBe(200);

    const limited = await messageRequest(app);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: CHAT_RATE_LIMITED });
    expect(limited.headers.get('Retry-After')).not.toBeNull();
    expect(agent.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('rate-limits the streaming endpoint before it starts SSE', async () => {
    const cache = createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]);
    const app = createApp({
      agent: createFakeAgent({ descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true }, sendMessageStream: vi.fn(async () => ({ reply: 'ok', sessionId: '550e8400-e29b-41d4-a716-446655440099', agentId: 'test-agent', failedTools: [] })) }),
      cache,
      writeAccess: authorizedDeps(),
      rateLimit: { perMinute: 2 },
    });
    expect((await streamMessageRequest(app)).status).toBe(200);
    expect((await streamMessageRequest(app)).status).toBe(200);
    const limited = await streamMessageRequest(app);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: CHAT_RATE_LIMITED });
  });

  it('applies configured model weights to tunnel message requests', async () => {
    const agent = silentAgent([{ id: 'opus', label: 'Opus', weight: 100 }]);
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      agent,
      cache,
      writeAccess: authorizedDeps(),
      rateLimit: {
        perMinute: 1000,
        perDay: 100,
      },
    });

    const body = JSON.stringify({
      projectId: 'proj-a',
      message: 'hi',
      model: 'opus',
    });
    const first = await app.request(
      '/api/chat/message',
      withLocalHost({ method: 'POST', headers: TUNNEL_HEADERS, body }),
      LOCAL_ENV,
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      '/api/chat/message',
      withLocalHost({ method: 'POST', headers: TUNNEL_HEADERS, body }),
      LOCAL_ENV,
    );
    expect(second.status).toBe(429);
  });

  it('allows tunnel requests again after the minute window elapses', async () => {
    let currentMs = 0;
    const agent = silentAgent();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      agent,
      cache,
      writeAccess: authorizedDeps(),
      now: () => new Date(currentMs),
      rateLimit: { perMinute: 2 },
    });

    expect((await messageRequest(app)).status).toBe(200);
    expect((await messageRequest(app)).status).toBe(200);
    expect((await messageRequest(app)).status).toBe(429);

    currentMs += 61_000;
    expect((await messageRequest(app)).status).toBe(200);
  });

  it('keeps denying tunnel requests after the minute window when the daily limit is reached', async () => {
    let currentMs = 0;
    const agent = silentAgent();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      agent,
      cache,
      writeAccess: authorizedDeps(),
      now: () => new Date(currentMs),
      rateLimit: { perMinute: 10, perDay: 2 },
    });

    expect((await messageRequest(app)).status).toBe(200);
    expect((await messageRequest(app)).status).toBe(200);
    expect((await messageRequest(app)).status).toBe(429);

    currentMs += 61_000;
    expect((await messageRequest(app)).status).toBe(429);
  });

  it('caches availability without consuming the rate limit on cache hits', async () => {
    const agent = silentAgent();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      agent,
      cache,
      writeAccess: authorizedDeps(),
      rateLimit: { perMinute: 2 },
    });

    for (let i = 0; i < 3; i += 1) {
      const res = await app.request(
        '/api/chat/availability',
        { headers: { 'CF-Ray': 'abc123-NRT', Cookie: TUNNEL_HEADERS.Cookie } },
        LOCAL_ENV,
      );
      expect(res.status).toBe(200);
    }
    expect(agent.checkAvailability).toHaveBeenCalledTimes(1);

    const messageRes = await messageRequest(app);
    expect(messageRes.status).toBe(200);
  });

  it('re-runs availability after the cache TTL expires', async () => {
    let currentMs = 0;
    const agent = silentAgent();
    const app = createApp({
      agent,
      writeAccess: authorizedDeps(),
      now: () => new Date(currentMs),
      availabilityCacheMs: 60_000,
      rateLimit: { perMinute: 10 },
    });

    const availabilityHeaders = {
      'CF-Ray': 'abc123-NRT',
      Cookie: TUNNEL_HEADERS.Cookie,
    };

    await app.request(
      '/api/chat/availability',
      withLocalHost({ headers: availabilityHeaders }),
      LOCAL_ENV,
    );
    expect(agent.checkAvailability).toHaveBeenCalledTimes(1);

    currentMs += 61_000;
    await app.request(
      '/api/chat/availability',
      withLocalHost({ headers: availabilityHeaders }),
      LOCAL_ENV,
    );
    expect(agent.checkAvailability).toHaveBeenCalledTimes(2);
  });

  it('applies rate limiting only after authorization succeeds', async () => {
    const agent = silentAgent();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    let tunnelWriteAllowed = false;
    const app = createApp({
      agent,
      cache,
      writeAccess: authorizedDeps({
        isTunnelWriteAllowed: () => tunnelWriteAllowed,
      }),
      rateLimit: { perMinute: 1 },
    });

    for (let i = 0; i < 3; i += 1) {
      const res = await messageRequest(app);
      expect(res.status).toBe(403);
    }
    expect(agent.sendMessage).not.toHaveBeenCalled();

    tunnelWriteAllowed = true;
    expect((await messageRequest(app)).status).toBe(200);
  });
});

describe('chat sessionId validation and agentId (bdboard-l1t.2 step 2)', () => {
  it('lists and adopts discovered sessions', async () => {
    const cache = createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]);
    const discovery: ChatSessionDiscoveryPort = {
      listDiscoveredSessions: vi.fn(async () => [{ sessionId: 'session-1', lastActivityAt: NOW }]),
      verifySessionExists: vi.fn(async (_project, _projects, sessionId) => sessionId === 'session-1'),
      readAdoptSeedMessages: vi.fn(async (_project, _projects, sessionId) =>
        sessionId === 'session-1'
          ? [{ role: 'user' as const, text: 'seeded question', timestamp: NOW.toISOString() }]
          : undefined,
      ),
    };
    // bdboard-l1t.5 Opus レビュー SF6(b): discovery が発見するのは claude CLI の
    // トランスクリプトだけなので、adopt が受け付ける agentId も 'claude' 固定になった
    // (それ以外は登録済みでも拒否する)。そのためここでは agent の id を 'claude' にして
    // 登録する(以前は汎用の 'test-agent' を明示指定して adopt できたが、それ自体が
    // discovery の実体と矛盾する構成だったため許可しなくなった)。
    const app = createApp({
      cache,
      sessionDiscovery: discovery,
      agent: createFakeAgent({
        descriptor: { id: 'claude', label: 'Claude', models: [{ id: 'sonnet', label: 'Sonnet' }], experimental: false, capability: 'bd-only' },
      }),
    });
    const listed = await app.request('/api/chat/projects/proj-a/discovered-sessions', withLocalHost({}), LOCAL_ENV);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ sessions: [{ sessionId: 'session-1', lastActivityAt: NOW.toISOString(), alreadyAdopted: false }] });

    const adopted = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions/session-1/adopt',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'claude' }),
      }),
      LOCAL_ENV,
    );
    expect(adopted.status).toBe(200);
    expect(await adopted.json()).toEqual({
      sessionId: 'session-1',
      agentId: 'claude',
      seedMessages: [{ role: 'user', text: 'seeded question', timestamp: NOW.toISOString() }],
    });
  });

  it('rejects adopt with a non-claude agentId even when that agent is registered (bdboard-l1t.5 Opus review SF6b)', async () => {
    const cache = createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]);
    const discovery: ChatSessionDiscoveryPort = {
      listDiscoveredSessions: vi.fn(async () => [{ sessionId: 'session-1', lastActivityAt: NOW }]),
      verifySessionExists: vi.fn(async () => true),
      readAdoptSeedMessages: vi.fn(async () => []),
    };
    // 'test-agent' はデフォルトで登録されているが、discovery の実体が claude CLI
    // トランスクリプトである以上、登録済みであっても拒否されなければならない。
    const app = createApp({ cache, sessionDiscovery: discovery });
    const adopted = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions/session-1/adopt',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'test-agent' }),
      }),
      LOCAL_ENV,
    );
    expect(adopted.status).toBe(400);
  });

  it('returns discovery availability and validation errors', async () => {
    const missing = await createApp().request('/api/chat/projects/proj-a/discovered-sessions', withLocalHost({}), LOCAL_ENV);
    expect(missing.status).toBe(501);
    const discovery: ChatSessionDiscoveryPort = {
      listDiscoveredSessions: vi.fn(async () => []),
      verifySessionExists: vi.fn(async () => true),
      readAdoptSeedMessages: vi.fn(async () => []),
    };
    const app = createApp({
      cache: createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]),
      sessionDiscovery: discovery,
    });
    const unknown = await app.request('/api/chat/projects/nope/discovered-sessions', withLocalHost({}), LOCAL_ENV);
    expect(unknown.status).toBe(404);
    const invalid = await app.request('/api/chat/projects/proj-a/discovered-sessions/..s1/adopt', withLocalHost({ method: 'POST' }), LOCAL_ENV);
    expect(invalid.status).toBe(400);
    // N6: URL エンコードされた traversal 形式(`..%2f` = `../`)も、Hono のパスパラメータ
    // デコード後に同じ `includes('..')` チェックへ落ちて 400 になることを固定する。
    const encodedTraversal = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions/..%2fsecret/adopt',
      withLocalHost({ method: 'POST' }),
      LOCAL_ENV,
    );
    expect(encodedTraversal.status).toBe(400);
  });

  // bdboard-3tw.104.3 レビュー MF1: 発見/adopt は通常の chatGuard (トンネル書き込み許可が
  // あれば通す) より厳しく常にローカル限定。トンネル利用者が自分で作っていない端末セッションの
  // トランスクリプトを閲覧・再開できてしまうため、当面ローカル限定。外部開放はユーザー裁定
  // チケット参照。トンネル書き込みが許可された状態でも 403 になることを固定する。
  it('keeps discovered-sessions and adopt local-only even when tunnel writes are otherwise authorized', async () => {
    const cache = createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]);
    const discovery: ChatSessionDiscoveryPort = {
      listDiscoveredSessions: vi.fn(async () => [{ sessionId: 'session-1', lastActivityAt: NOW }]),
      verifySessionExists: vi.fn(async () => true),
      readAdoptSeedMessages: vi.fn(async () => []),
    };
    // bdboard-l1t.5 Opus レビュー SF6(b): adopt が受け付ける agentId は 'claude' 固定に
    // なったため、対照実験(下記 adoptedLocal)が 200 になるよう agent を 'claude' として登録する。
    const app = createApp({
      cache,
      sessionDiscovery: discovery,
      agent: createFakeAgent({
        descriptor: { id: 'claude', label: 'Claude', models: [{ id: 'sonnet', label: 'Sonnet' }], experimental: false, capability: 'bd-only' },
      }),
      writeAccess: {
        isTunnelWriteAllowed: () => true,
        hasTunnelSession: () => true,
      },
    });
    const tunnelHeaders = {
      'CF-Ray': 'abc123-NRT',
      Cookie: 'bdboard_tunnel_session=example-session-value',
      'Content-Type': 'application/json',
    };

    const listed = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions',
      { headers: tunnelHeaders },
      LOCAL_ENV,
    );
    expect(listed.status).toBe(403);
    expect(discovery.listDiscoveredSessions).not.toHaveBeenCalled();
    // N2: 403 本文は専用の export 定数と一致する(リテラル文字列の重複を避ける)。
    expect(await listed.json()).toEqual({ error: CHAT_SESSION_DISCOVERY_LOCAL_ONLY });

    const adopted = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions/session-1/adopt',
      { method: 'POST', headers: tunnelHeaders, body: '{}' },
      LOCAL_ENV,
    );
    expect(adopted.status).toBe(403);
    expect(discovery.verifySessionExists).not.toHaveBeenCalled();
    expect(await adopted.json()).toEqual({ error: CHAT_SESSION_DISCOVERY_LOCAL_ONLY });

    // 対照実験: 同じ経路がローカルなら通る(200)。
    const listedLocal = await app.request('/api/chat/projects/proj-a/discovered-sessions', withLocalHost({}), LOCAL_ENV);
    expect(listedLocal.status).toBe(200);
    const adoptedLocal = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions/session-1/adopt',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'claude' }),
      }),
      LOCAL_ENV,
    );
    expect(adoptedLocal.status).toBe(200);
  });
});

describe('chat routes DNS rebinding resistance', () => {
  // discoverySessionsLocalOnlyGuard はトンネル経由を一切許さずローカル直
  // アクセスのみを要求する。ここでは外側の chatGuard をトンネル資格で通した
  // 上で、CF-Ray ヘッダを付けないループバック+Host偽装リクエストが
  // discoverySessionsLocalOnlyGuard 自身でも「ローカルではない」と判定される
  // ことを固定する(修正前は isLocalControlRequest が Host を見ないため、
  // ここが誤ってローカル扱いになり discovered-sessions が漏れていた)。
  it('does not treat loopback with a spoofed Host as local for discovered-sessions even when a tunnel session would otherwise authorize the request', async () => {
    const cache = createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]);
    const discovery: ChatSessionDiscoveryPort = {
      listDiscoveredSessions: vi.fn(async () => []),
      verifySessionExists: vi.fn(async () => true),
      readAdoptSeedMessages: vi.fn(async () => []),
    };
    const app = createApp({
      cache,
      sessionDiscovery: discovery,
      writeAccess: { isTunnelWriteAllowed: () => true, hasTunnelSession: () => true },
    });
    const res = await app.request(
      '/api/chat/projects/proj-a/discovered-sessions',
      {
        headers: {
          Host: 'attacker.example:8787',
          Cookie: 'bdboard_tunnel_session=example-session-value',
        },
      },
      LOCAL_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CHAT_SESSION_DISCOVERY_LOCAL_ONLY });
    expect(discovery.listDiscoveredSessions).not.toHaveBeenCalled();
  });

  // availability のレート制限スキップ判定も同じ理由で狙われうる: CF-Ray無し・
  // ループバック・Host偽装のリクエストをトンネル資格で通した場合、修正前の
  // isLocalControlRequest ベースの判定だと「ローカル」と誤判定してレート制限を
  // スキップしてしまう(= トンネル経路のはずのリクエストがレート制限を回避できる)。
  // 修正後は Host 検証込みなので「ローカルではない」と正しく判定され、
  // レート制限が効く。
  it('does not let a spoofed-Host loopback request skip the availability rate limit via a tunnel session', async () => {
    const cache = createFakeBoardCache([cachedProject(project('proj-a', '/projects/a'))]);
    const app = createApp({
      cache,
      rateLimit: { perMinute: 1 },
      availabilityCacheMs: 0,
      writeAccess: { isTunnelWriteAllowed: () => true, hasTunnelSession: () => true },
    });
    const headers = {
      Host: 'attacker.example:8787',
      Cookie: 'bdboard_tunnel_session=example-session-value',
    };
    const first = await app.request('/api/chat/availability', { headers }, LOCAL_ENV);
    expect(first.status).toBe(200);
    const second = await app.request('/api/chat/availability', { headers }, LOCAL_ENV);
    expect(second.status).toBe(429);
  });
});
