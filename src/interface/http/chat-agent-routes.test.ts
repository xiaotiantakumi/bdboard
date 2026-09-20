import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { CHAT_RATE_LIMITED } from './chat-rate-limit.js';
import { CHAT_NOT_AUTHORIZED } from './chat-routes.js';
import type { WriteGuardDeps } from './write-guard.js';
import { createChatSessionStore } from '../../application/chat/chat-session-store.js';
import { createInMemoryChatMessageRepository } from '../../application/chat/in-memory-chat-message-repository.js';
import { createChatAgentRegistry } from '../../application/chat/chat-agent-registry.js';
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
// ルートモジュール分割 (bdboard-sso1.17) に追随させて move-only 分割した一部
// (GET /api/chat/availability, GET /api/chat/agents)。テスト本体・期待値・モックの
// 記述は元の chat-routes.test.ts から一字一句変更していない。describe の入れ物のみ
// 再構成した: availability の2件は元 'createChatRoutes behavior' から抽出し、
// 新しい describe 'GET /api/chat/availability' にまとめた。
describe('GET /api/chat/availability', () => {
  it('returns availability from the agent', async () => {
    const checkAvailability = vi.fn(async () => 'available' as const);
    const app = createApp({ agent: createFakeAgent({ checkAvailability }) });

    const res = await app.request('/api/chat/availability', withLocalHost({}), LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ availability: 'available' });
    expect(checkAvailability).toHaveBeenCalled();
  });

  it('returns availability unknown when checkAvailability throws', async () => {
    const app = createApp({
      agent: createFakeAgent({
        checkAvailability: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
    });

    const res = await app.request('/api/chat/availability', withLocalHost({}), LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ availability: 'unknown' });
  });
});

describe('GET /api/chat/agents (bdboard-l1t.2 step 2)', () => {
  it('returns an array of agent descriptors with availability', async () => {
    const withModel = createFakeAgent({
      descriptor: {
        id: 'alpha',
        label: 'Alpha Agent',
        model: 'example-model',
        models: [
          { id: 'example-model', label: 'example-model' },
          { id: 'other-model', label: 'other-model' },
        ],
        experimental: false,
        supportsImages: true,
        capability: 'bd-only',
      },
    });
    const withoutModel = createFakeAgent({
      descriptor: {
        id: 'beta',
        label: 'Beta Agent',
        models: [],
        experimental: true,
        capability: 'reads-project',
      },
    });
    const registry = createChatAgentRegistry();
    registry.register(withModel);
    registry.register(withoutModel);
    const app = createApp({ agents: registry });

    const res = await app.request('/api/chat/agents', withLocalHost({}), LOCAL_ENV);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);

    expect(body[0]).toEqual({
      id: 'alpha',
      label: 'Alpha Agent',
      model: 'example-model',
      models: [
        { id: 'example-model', label: 'example-model' },
        { id: 'other-model', label: 'other-model' },
      ],
      experimental: false,
      supportsStreaming: false,
      supportsImages: true,
      capability: 'bd-only',
      availability: 'available',
    });
    expect(body[1]).toEqual({
      id: 'beta',
      label: 'Beta Agent',
      models: [],
      experimental: true,
      supportsStreaming: false,
      supportsImages: false,
      capability: 'reads-project',
      availability: 'available',
    });
    expect(body[1]).not.toHaveProperty('model');
  });

  it('returns availability unavailable for an agent that is not logged in', async () => {
    const loggedOut = createFakeAgent({
      descriptor: {
        id: 'claude',
        label: 'Claude',
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        experimental: false,
        capability: 'bd-only',
      },
      checkAvailability: vi.fn(async () => 'unavailable' as const),
    });
    const registry = createChatAgentRegistry();
    registry.register(loggedOut);
    const app = createApp({ agents: registry });

    const res = await app.request('/api/chat/agents', withLocalHost({}), LOCAL_ENV);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual([
      expect.objectContaining({
        id: 'claude',
        availability: 'unavailable',
      }),
    ]);
  });

  it('returns 403 for non-local requests without write access', async () => {
    const app = createApp();

    const res = await app.request(
      '/api/chat/agents',
      {},
      { incoming: { socket: { remoteAddress: '203.0.113.5' } } },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CHAT_NOT_AUTHORIZED });
  });
});

describe('chat agents rate limit and per-agent availability cache (bdboard-l1t.2 step 2)', () => {
  const TUNNEL_HEADERS = {
    'CF-Ray': 'abc123-NRT',
    Cookie: 'bdboard_tunnel_session=example-session-value',
  } as const;

  async function messageRequest(app: Hono): Promise<Response> {
    return await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { ...TUNNEL_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      LOCAL_ENV,
    );
  }

  function authorizedDeps(): WriteGuardDeps {
    return {
      isTunnelWriteAllowed: () => true,
      hasTunnelSession: () => true,
    };
  }

  it('rate-limits GET /api/chat/agents but exempts GET /api/chat/availability', async () => {
    const agent = createFakeAgent();
    const app = createApp({
      agent,
      writeAccess: authorizedDeps(),
      rateLimit: { perMinute: 2 },
    });

    for (let i = 0; i < 2; i += 1) {
      const res = await app.request(
        '/api/chat/agents',
        withLocalHost({ headers: TUNNEL_HEADERS }),
        LOCAL_ENV,
      );
      expect(res.status).toBe(200);
    }

    const limited = await app.request(
      '/api/chat/agents',
      withLocalHost({ headers: TUNNEL_HEADERS }),
      LOCAL_ENV,
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: CHAT_RATE_LIMITED });

    for (let i = 0; i < 3; i += 1) {
      const res = await app.request(
        '/api/chat/availability',
        withLocalHost({ headers: TUNNEL_HEADERS }),
        LOCAL_ENV,
      );
      expect(res.status).toBe(200);
    }
  });

  it('exempts read-only chat GETs without consuming the tunnel rate limit', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    const store = createChatSessionStore();
    const messages = createInMemoryChatMessageRepository();
    store.remember('proj-a', sessionId, 'test-agent');
    messages.append(sessionId, [{ role: 'user', content: 'hello' }]);
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      agent: createFakeAgent(),
      cache,
      store,
      messages,
      writeAccess: authorizedDeps(),
      rateLimit: { perMinute: 2 },
    });

    for (let i = 0; i < 5; i += 1) {
      const sessionMessages = await app.request(
        `/api/chat/sessions/${sessionId}/messages?projectId=proj-a`,
        withLocalHost({ headers: TUNNEL_HEADERS }),
        LOCAL_ENV,
      );
      expect(sessionMessages.status).toBe(200);

      const threads = await app.request(
        '/api/chat/threads?projectId=proj-a',
        withLocalHost({ headers: TUNNEL_HEADERS }),
        LOCAL_ENV,
      );
      expect(threads.status).toBe(200);

      const turnStatus = await app.request(
        '/api/chat/turn-status?projectId=proj-a',
        withLocalHost({ headers: TUNNEL_HEADERS }),
        LOCAL_ENV,
      );
      expect(turnStatus.status).toBe(200);

      const ack = await app.request(
        `/api/chat/turn-status?projectId=proj-a&sessionId=${sessionId}`,
        withLocalHost({ method: 'DELETE', headers: TUNNEL_HEADERS }),
        LOCAL_ENV,
      );
      expect(ack.status).toBe(204);
    }

    expect((await messageRequest(app)).status).toBe(200);
    expect((await messageRequest(app)).status).toBe(200);
    expect((await messageRequest(app)).status).toBe(429);
  });

  it('keeps read-only chat GETs behind the chat guard', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    const paths = [
      `/api/chat/sessions/${sessionId}/messages?projectId=proj-a`,
      '/api/chat/threads?projectId=proj-a',
      '/api/chat/turn-status?projectId=proj-a',
    ];

    for (const path of paths) {
      const res = await createApp().request(
        path,
        { method: 'GET' },
        { incoming: { socket: { remoteAddress: '203.0.113.5' } } },
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: CHAT_NOT_AUTHORIZED });
    }

    const ack = await createApp().request(
      `/api/chat/turn-status?projectId=proj-a&sessionId=${sessionId}`,
      { method: 'DELETE' },
      { incoming: { socket: { remoteAddress: '203.0.113.5' } } },
    );
    expect(ack.status).toBe(403);
    expect(await ack.json()).toEqual({ error: CHAT_NOT_AUTHORIZED });
  });

  it('shares per-agent availability cache between /agents and /availability', async () => {
    const alphaAvailable = vi.fn(async () => 'available' as const);
    const betaAvailable = vi.fn(async () => 'available' as const);
    const alpha = createFakeAgent({
      descriptor: {
        id: 'alpha',
        label: 'Alpha',
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        experimental: false,
        capability: 'bd-only',
      },
      checkAvailability: alphaAvailable,
    });
    const beta = createFakeAgent({
      descriptor: {
        id: 'beta',
        label: 'Beta',
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        experimental: false,
        capability: 'bd-only',
      },
      checkAvailability: betaAvailable,
    });
    const registry = createChatAgentRegistry();
    registry.register(alpha);
    registry.register(beta);
    const app = createApp({ agents: registry, availabilityCacheMs: 60_000 });

    await app.request('/api/chat/agents', withLocalHost({}), LOCAL_ENV);
    await app.request('/api/chat/agents', withLocalHost({}), LOCAL_ENV);
    expect(alphaAvailable).toHaveBeenCalledTimes(1);
    expect(betaAvailable).toHaveBeenCalledTimes(1);

    await app.request('/api/chat/availability', withLocalHost({}), LOCAL_ENV);
    expect(alphaAvailable).toHaveBeenCalledTimes(1);
  });
});

