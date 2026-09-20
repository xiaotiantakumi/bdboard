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
  cachedProject,
  createApp,
  createFakeAgent,
  createFakeBoardCache,
  project,
  withLocalHost,
} from './chat-routes-test-support.js';

// bdboard-sso1.31: chat-routes.test.ts (chat ルート総合テスト) を実装側の chat
// ルートモジュール分割 (bdboard-sso1.17) に追随させて move-only 分割した最終PR
// (3/3)。'chat sessionId validation and agentId' describe の残り
// (discovered-sessions の list/adopt 4テスト) を chat-discovery-routes.test.ts
// へ抽出し、その際に説明的でなかった describe 名を内容に合わせて改めた
// (bdboard-sso1.31 PR2/3 レビュー finding #1)。残りのテスト本体・期待値・
// モックの記述は元の chat-routes.test.ts から一字一句変更していない。ここに
// 残るのはトンネル認証・rate limit・local-only guard・DNS rebinding という、
// createChatRoutes 全体にまたがる横断的なテストのみで、個別リソース
// モジュールへは分解しない(composition layer 自体のテストとして構成層の
// ファイルに残す, bdboard-sso1.7 の前例と同じ方針)。
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
