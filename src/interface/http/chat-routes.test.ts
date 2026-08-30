import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { compareStrings } from '../../domain/compare.js';
import { makeTicket } from '../../domain/test-support.js';
import type { Project } from '../../domain/project.js';
import type { BoardCache, CachedProject } from '../../application/ports/board-cache.js';
import type { ChatSessionDiscoveryPort } from '../../application/ports/chat-session-discovery.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../../application/ports/board-cache-fakes.js';
import {
  CHAT_FAILURE_MESSAGES,
  ChatAgentError,
  type ChatTurnResult,
  type ChatAgentPort,
} from '../../application/ports/chat-agent.js';
import { createChatSessionStore } from '../../application/chat/chat-session-store.js';
import { createInMemoryChatMessageRepository } from '../../application/chat/in-memory-chat-message-repository.js';
import { createChatAgentRegistry } from '../../application/chat/chat-agent-registry.js';
import {
  CHAT_CSRF_DENIED,
  CHAT_NOT_AUTHORIZED,
  CHAT_SESSION_DISCOVERY_LOCAL_ONLY,
  createChatRoutes,
} from './chat-routes.js';
import { CHAT_RATE_LIMITED } from './chat-rate-limit.js';
import type { WriteGuardDeps } from './write-guard.js';

const LOCAL_HOST = 'localhost:8787';

const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
      localPort: 8787,
    },
  },
};

function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}

const NOW = new Date('2026-08-15T12:00:00.000Z');
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64');

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function createFakeBoardCache(
  entries: readonly CachedProject[] = [],
): BoardCache {
  const byId = new Map(entries.map((entry) => [entry.project.id, entry]));

  return {
    getProject(projectId: string): CachedProject | undefined {
      return byId.get(projectId);
    },
    putProject(entry: CachedProject): void {
      byId.set(entry.project.id, entry);
    },
    listProjects(): readonly CachedProject[] {
      return [...byId.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
    },
    deleteProject(projectId: string): void {
      byId.delete(projectId);
    },
    clear(): void {
      byId.clear();
    },
    getTranscriptOffset(): number | undefined {
      return undefined;
    },
    setTranscriptOffset(): void {},
    addSessionUsage(): void {},
    getSessionUsage(): readonly never[] {
      return [];
    },
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close(): void {},
  };
}

function cachedProject(proj: Project): CachedProject {
  return {
    project: proj,
    tickets: [makeTicket({ id: 'bdboard-1', projectId: proj.id })],
    fingerprint: `fp-${proj.id}`,
    fetchedAt: NOW,
  };
}

function createFakeAgent(
  overrides: Partial<ChatAgentPort> = {},
): ChatAgentPort {
  return {
    descriptor: {
      id: 'test-agent',
      label: 'Test Agent',
      models: [{ id: 'sonnet', label: 'Sonnet' }],
      experimental: false,
      supportsStreaming: false,
      capability: 'bd-only',
    },
    checkAvailability: vi.fn(async () => 'available' as const),
    sendMessage: vi.fn(async () => ({
      reply: 'hello from agent',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      failedTools: [],
      agentId: 'test-agent',
    })),
    ...overrides,
  };
}

function createApp(
  overrides: {
    readonly cache?: BoardCache;
    readonly agent?: ChatAgentPort;
    readonly agents?: ReturnType<typeof createChatAgentRegistry>;
    readonly store?: ReturnType<typeof createChatSessionStore>;
    readonly messages?: ReturnType<typeof createInMemoryChatMessageRepository>;
    readonly writeAccess?: WriteGuardDeps;
    readonly now?: () => Date;
    readonly rateLimit?: {
      readonly perMinute?: number;
      readonly perDay?: number;
      readonly defaultWeight?: number;
    };
    readonly availabilityCacheMs?: number;
    readonly sessionDiscovery?: ChatSessionDiscoveryPort;
  } = {},
): Hono {
  const agents =
    overrides.agents ??
    (() => {
      const registry = createChatAgentRegistry();
      registry.register(overrides.agent ?? createFakeAgent());
      return registry;
    })();

  return createChatRoutes({
    cache: overrides.cache ?? createFakeBoardCache(),
    agents,
    store: overrides.store ?? createChatSessionStore(),
    messages: overrides.messages ?? createInMemoryChatMessageRepository(),
    ...(overrides.writeAccess !== undefined
      ? { writeAccess: overrides.writeAccess }
      : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides.rateLimit !== undefined ? { rateLimit: overrides.rateLimit } : {}),
    ...(overrides.availabilityCacheMs !== undefined
      ? { availabilityCacheMs: overrides.availabilityCacheMs }
      : {}),
    ...(overrides.sessionDiscovery !== undefined
      ? { sessionDiscovery: overrides.sessionDiscovery }
      : {}),
  });
}

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

describe('POST /api/chat/message/stream', () => {
  it('decodes and propagates image attachments through the streaming request', async () => {
    const streamingAgent = createFakeAgent({
      descriptor: {
        ...createFakeAgent().descriptor,
        supportsStreaming: true,
        supportsImages: true,
      },
      sendMessageStream: vi.fn(async () => ({
        reply: 'image reply',
        sessionId: 'stream-image-session',
        agentId: 'test-agent',
        failedTools: [],
      })),
    });
    const app = createApp({
      agent: streamingAgent,
      cache: createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]),
    });
    const res = await app.request('/api/chat/message/stream', withLocalHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p',
        message: 'look',
        images: [{ mimeType: 'image/png', data: PNG_BASE64 }],
      }),
    }), LOCAL_ENV);

    expect(res.status).toBe(200);
    await res.text();
    const request = vi.mocked(streamingAgent.sendMessageStream!).mock.calls[0]?.[0];
    expect(request?.images?.[0]?.mimeType).toBe('image/png');
    expect([...request!.images![0]!.data]).toEqual(PNG_BYTES);
  });

  it('streams deltas followed by the finalized turn', async () => {
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (_request, onDelta) => {
        onDelta({ text: 'AB' });
        onDelta({ text: 'CD' });
        return { reply: 'ABCD', sessionId: '550e8400-e29b-41d4-a716-446655440099', agentId: 'test-agent', failedTools: [] };
      }),
    });
    const app = createApp({ agent: streamingAgent, cache: createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]) });
    const res = await app.request('/api/chat/message/stream', withLocalHost({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'p', message: 'hello' }),
    }), LOCAL_ENV);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.match(/event: delta/g)).toHaveLength(2);
    expect(text.match(/event: done/g)).toHaveLength(1);
    expect(text).toContain('"reply":"ABCD"');
    const status = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await status.json()).toEqual(expect.objectContaining({
      state: 'completed',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
    }));
    const ack = await app.request(
      '/api/chat/turn-status?projectId=p&sessionId=550e8400-e29b-41d4-a716-446655440099',
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(ack.status).toBe(204);
    const idle = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await idle.json()).toEqual({ state: 'idle' });
  });

  it('returns JSON 400 without starting SSE for a non-streaming agent', async () => {
    const app = createApp({ cache: createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]) });
    const res = await app.request('/api/chat/message/stream', withLocalHost({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'p', message: 'hello' }),
    }), LOCAL_ENV);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'chat agent does not support streaming' });
  });

  it('keeps the server turn running after bdboard-7st aborts only the client subscription', async () => {
    let resolveAgent: (result: ChatTurnResult) => void = () => {};
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(
        async (): Promise<ChatTurnResult> =>
          await new Promise<ChatTurnResult>((resolve) => {
            resolveAgent = resolve;
          }),
      ),
    });
    const store = createChatSessionStore();
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: streamingAgent, cache, store, now: () => NOW });
    const controller = new AbortController();
    const responsePromise = app.request(
      '/api/chat/message/stream',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', message: 'hello' }),
        signal: controller.signal,
      }),
      LOCAL_ENV,
    );

    await vi.waitFor(() => expect(streamingAgent.sendMessageStream).toHaveBeenCalled());
    controller.abort();
    expect(vi.mocked(streamingAgent.sendMessageStream!).mock.calls[0]?.[2]).toBeUndefined();

    const processing = await app.request(
      '/api/chat/turn-status?projectId=p',
      withLocalHost({}),
      LOCAL_ENV,
    );
    expect(await processing.json()).toEqual({
      state: 'processing',
      message: 'hello',
      agentId: 'test-agent',
    });

    resolveAgent({
      reply: 'reply after disconnect',
      sessionId: '550e8400-e29b-41d4-a716-446655440088',
      agentId: 'test-agent',
      failedTools: [],
    });
    await responsePromise;
    await vi.waitFor(() =>
      expect(store.lookup('p', '550e8400-e29b-41d4-a716-446655440088')).toEqual({
        agentId: 'test-agent',
      }),
    );
    const completed = await app.request(
      '/api/chat/turn-status?projectId=p',
      withLocalHost({}),
      LOCAL_ENV,
    );
    expect(await completed.json()).toEqual({
      state: 'completed',
      sessionId: '550e8400-e29b-41d4-a716-446655440088',
      agentId: 'test-agent',
      completedAt: NOW.toISOString(),
    });

    const followUp = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', message: 'follow-up' }),
      }),
      LOCAL_ENV,
    );
    expect(followUp.status).toBe(200);
  });

  it('persists a detached turn that resolves after the client disconnects', async () => {
    let resolveAgent: (result: ChatTurnResult) => void = () => {};
    let sendMessageStreamCalled = false;
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(
        async (): Promise<ChatTurnResult> => {
          sendMessageStreamCalled = true;
          return await new Promise<ChatTurnResult>((resolve) => {
            resolveAgent = resolve;
          });
        },
      ),
    });
    const store = createChatSessionStore();
    const rememberSpy = vi.spyOn(store, 'remember');
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: streamingAgent, cache, store });
    const controller = new AbortController();
    const responsePromise = app.request(
      '/api/chat/message/stream',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', message: 'hello' }),
        signal: controller.signal,
      }),
      LOCAL_ENV,
    );

    // The accepted server turn must already be running before the subscriber leaves.
    await vi.waitFor(() => expect(sendMessageStreamCalled).toBe(true));
    controller.abort();
    await responsePromise;

    // Resolving after disconnect must still cross the same durable finalize boundary.
    resolveAgent({
      reply: 'late reply',
      sessionId: '550e8400-e29b-41d4-a716-446655440077',
      agentId: 'test-agent',
      failedTools: [],
    });

    await vi.waitFor(() =>
      expect(rememberSpy).toHaveBeenCalledWith(
        'p',
        '550e8400-e29b-41d4-a716-446655440077',
        'test-agent',
      ),
    );
  });

  it('streaming done payload matches the bulk 200 body shape for the same turn (bdboard-l1t.9 delta 再レビュー N2)', async () => {
    const turnResult: ChatTurnResult = {
      reply: 'same reply',
      sessionId: '550e8400-e29b-41d4-a716-446655440042',
      agentId: 'test-agent',
      failedTools: [],
    };
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);

    const bulkAgent = createFakeAgent({
      sendMessage: vi.fn(async () => turnResult),
    });
    const bulkApp = createApp({ agent: bulkAgent, cache });
    const bulkRes = await bulkApp.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', message: 'hello' }),
      }),
      LOCAL_ENV,
    );
    expect(bulkRes.status).toBe(200);
    const bulkBody: unknown = await bulkRes.json();

    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async () => turnResult),
    });
    const streamApp = createApp({ agent: streamingAgent, cache });
    const streamRes = await streamApp.request(
      '/api/chat/message/stream',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', message: 'hello' }),
      }),
      LOCAL_ENV,
    );
    expect(streamRes.status).toBe(200);
    const streamText = await streamRes.text();
    const doneMatch = streamText.match(/event: done\ndata: (.+)\n/);
    expect(doneMatch).not.toBeNull();
    const doneBody: unknown = JSON.parse(doneMatch![1]!);

    // N2: 同じターン結果から組み立てた streaming の done payload と bulk の
    // 200 ボディが、形まで含めて完全に一致することを固定する(bulk 側には
    // 無い `ok` フィールドが streaming 側にだけ混ざっていないことも含む)。
    expect(doneBody).toEqual(bulkBody);
    expect(doneBody).not.toHaveProperty('ok');
  });

  it('sends ChatAgentError as a sanitized SSE error event', async () => {
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (): Promise<ChatTurnResult> => {
        throw new ChatAgentError('agent-timeout');
      }),
    });
    const app = createApp({
      agent: streamingAgent,
      cache: createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]),
    });

    const res = await app.request('/api/chat/message/stream', withLocalHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', message: 'hello' }),
    }), LOCAL_ENV);
    expect(res.status).toBe(200);
    const text = await res.text();
    const errorEvents = [...text.matchAll(/event: error\ndata: (.+)\n/g)];
    expect(errorEvents).toHaveLength(1);
    expect(JSON.parse(errorEvents[0]![1]!)).toEqual({
      error: 'chat failed',
      code: 'agent-timeout',
      detail: CHAT_FAILURE_MESSAGES['agent-timeout'],
    });
    expect(text).not.toContain('event: done');
    expect(Object.keys(JSON.parse(errorEvents[0]![1]!)).sort()).toEqual(['code', 'detail', 'error']);
  });

  describe('SSE keepalive ping', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('sends ping events every 15 seconds while the stream is open', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      let resolveTurn!: (result: ChatTurnResult) => void;
      const turnPromise = new Promise<ChatTurnResult>((resolve) => {
        resolveTurn = resolve;
      });

      const streamingAgent = createFakeAgent({
        descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
        sendMessageStream: vi.fn(async () => turnPromise),
      });
      const app = createApp({
        agent: streamingAgent,
        cache: createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]),
        now: () => NOW,
      });

      const responsePromise = app.request(
        '/api/chat/message/stream',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'p', message: 'hello' }),
        }),
        LOCAL_ENV,
      );

      await vi.waitFor(() => expect(streamingAgent.sendMessageStream).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(15_000);

      resolveTurn({
        reply: 'reply',
        sessionId: '550e8400-e29b-41d4-a716-446655440099',
        agentId: 'test-agent',
        failedTools: [],
      });

      const res = await responsePromise;
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.match(/event: ping/g)).toHaveLength(1);
      expect(text).toContain(`"now":"${NOW.toISOString()}"`);
      expect(text).toContain('event: done');
    });

    it('clears the ping timer when the stream closes', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      let resolveTurn!: (result: ChatTurnResult) => void;
      const turnPromise = new Promise<ChatTurnResult>((resolve) => {
        resolveTurn = resolve;
      });

      const streamingAgent = createFakeAgent({
        descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
        sendMessageStream: vi.fn(async () => turnPromise),
      });
      const app = createApp({
        agent: streamingAgent,
        cache: createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]),
      });

      const responsePromise = app.request(
        '/api/chat/message/stream',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'p', message: 'hello' }),
        }),
        LOCAL_ENV,
      );

      await vi.waitFor(() => expect(streamingAgent.sendMessageStream).toHaveBeenCalled());
      resolveTurn({
        reply: 'reply',
        sessionId: '550e8400-e29b-41d4-a716-446655440099',
        agentId: 'test-agent',
        failedTools: [],
      });

      const res = await responsePromise;
      await res.text();

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
      const timerId = setIntervalSpy.mock.results[0]?.value;
      expect(clearIntervalSpy).toHaveBeenCalledWith(timerId);

      await vi.advanceTimersByTimeAsync(30_000);
    });
  });

});

describe('detached bulk chat turn recovery', () => {
  it('keeps a bulk completion until the receiving client ACKs it', async () => {
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ cache });

    const response = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', message: 'hello' }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(200);
    const status = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    const completed = await status.json() as { state: string; sessionId: string };
    expect(completed).toEqual(expect.objectContaining({
      state: 'completed',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
    }));

    await app.request(
      `/api/chat/turn-status?projectId=p&sessionId=wrong-session`,
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(await (await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV)).json())
      .toEqual(expect.objectContaining({ state: 'completed' }));

    const ack = await app.request(
      `/api/chat/turn-status?projectId=p&sessionId=${completed.sessionId}`,
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(ack.status).toBe(204);
    expect(await (await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV)).json())
      .toEqual({ state: 'idle' });
  });

  it('continues a bulk turn after disconnect and exposes its completed session', async () => {
    let resolveAgent: (result: ChatTurnResult) => void = () => {};
    const sendMessage = vi.fn(
      async (): Promise<ChatTurnResult> =>
        await new Promise<ChatTurnResult>((resolve) => {
          resolveAgent = resolve;
        }),
    );
    const store = createChatSessionStore();
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({
      agent: createFakeAgent({ sendMessage }),
      cache,
      store,
      now: () => NOW,
    });
    const controller = new AbortController();
    const responsePromise = app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', message: 'hello' }),
        signal: controller.signal,
      }),
      LOCAL_ENV,
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    controller.abort();
    const processing = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await processing.json()).toEqual({
      state: 'processing',
      message: 'hello',
      agentId: 'test-agent',
    });

    resolveAgent({
      reply: 'bulk reply after disconnect',
      sessionId: 'bulk-detached-session',
      agentId: 'test-agent',
      failedTools: [],
    });
    await responsePromise;
    await vi.waitFor(() =>
      expect(store.lookup('p', 'bulk-detached-session')).toEqual({ agentId: 'test-agent' }),
    );
    const completed = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await completed.json()).toEqual({
      state: 'completed',
      sessionId: 'bulk-detached-session',
      agentId: 'test-agent',
      completedAt: NOW.toISOString(),
    });
  });

  it('keeps an earlier unacknowledged completion when a later turn completes', async () => {
    // bdboard-3tw.155: 以前は完了がプロジェクト1枠で、後続の送信が先行スレッドの
    // 未回収完了を黙って上書きしていた。返信を待たずに別スレッドへ移って会話すると
    // 必ず踏み、先に送ったスレッドの返信が二度と回収されなくなる。
    const sessionA = '550e8400-e29b-41d4-a716-4466554400aa';
    const sessionB = '550e8400-e29b-41d4-a716-4466554400bb';
    let resolveFirst: (result: ChatTurnResult) => void = () => {};
    let call = 0;
    const sendMessage = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return await new Promise<ChatTurnResult>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return {
        reply: 'reply for thread B',
        sessionId: sessionB,
        agentId: 'test-agent',
        failedTools: [],
      };
    });
    const store = createChatSessionStore();
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: createFakeAgent({ sendMessage }), cache, store, now: () => NOW });

    const controller = new AbortController();
    const first = app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', message: 'thread A' }),
        signal: controller.signal,
      }),
      LOCAL_ENV,
    );
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    controller.abort();
    resolveFirst({ reply: 'reply for thread A', sessionId: sessionA, agentId: 'test-agent', failedTools: [] });
    await first;

    const second = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', message: 'thread B' }),
      }),
      LOCAL_ENV,
    );
    expect(second.status).toBe(200);

    // 古い方から配る。Aを回収してACKすると、次にBが出てくる。
    expect(await (await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV)).json())
      .toEqual(expect.objectContaining({ state: 'completed', sessionId: sessionA }));
    const ackA = await app.request(
      `/api/chat/turn-status?projectId=p&sessionId=${sessionA}`,
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(ackA.status).toBe(204);
    expect(await (await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV)).json())
      .toEqual(expect.objectContaining({ state: 'completed', sessionId: sessionB }));
    const ackB = await app.request(
      `/api/chat/turn-status?projectId=p&sessionId=${sessionB}`,
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(ackB.status).toBe(204);
    expect(await (await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV)).json())
      .toEqual({ state: 'idle' });
  });

  it('does not erase an unacknowledged completion when a later streaming turn starts', async () => {
    // ストリーミング経路には「新しいターンが始まったら未回収の完了を消す」処理が
    // あった。UI の既定はストリーミングなので、実際に踏むのはこちら。
    const sessionA = '550e8400-e29b-41d4-a716-4466554400aa';
    const sessionB = '550e8400-e29b-41d4-a716-4466554400bb';
    let call = 0;
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (_request, onDelta) => {
        call += 1;
        const sessionId = call === 1 ? sessionA : sessionB;
        onDelta({ text: 'chunk' });
        return { reply: `reply ${call}`, sessionId, agentId: 'test-agent', failedTools: [] };
      }),
    });
    const app = createApp({
      agent: streamingAgent,
      cache: createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]),
      now: () => NOW,
    });

    for (const message of ['thread A', 'thread B']) {
      const res = await app.request(
        '/api/chat/message/stream',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'p', message }),
        }),
        LOCAL_ENV,
      );
      expect(res.status).toBe(200);
      await res.text();
    }

    // Aは未回収のまま残っていて、先に配られる。
    expect(await (await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV)).json())
      .toEqual(expect.objectContaining({ state: 'completed', sessionId: sessionA }));
    await app.request(
      `/api/chat/turn-status?projectId=p&sessionId=${sessionA}`,
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(await (await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV)).json())
      .toEqual(expect.objectContaining({ state: 'completed', sessionId: sessionB }));
  });

  it('drops the oldest completion once the queue is full (PR#135 レビュー nit-1)', async () => {
    // ACK しないクライアントに備えた歯止め (CHAT_COMPLETED_TURNS_MAX = 20)。
    // レビューで「上限の挙動だけテストが無く、slice(-MAX) を消しても全テストが
    // 通る」と指摘された箇所。上限を超えたら古い方から落ち、落ちた分の ACK は
    // エラーではなく no-op で済むことを固定する。
    const MAX = 20;
    const sessionIdFor = (index: number): string =>
      `550e8400-e29b-41d4-a716-4466554${index.toString().padStart(5, '0')}`;

    let call = 0;
    const sendMessage = vi.fn(async () => {
      const sessionId = sessionIdFor(call);
      call += 1;
      return { reply: `reply ${sessionId}`, sessionId, agentId: 'test-agent', failedTools: [] };
    });
    const store = createChatSessionStore();
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: createFakeAgent({ sendMessage }), cache, store, now: () => NOW });

    // 一度も ACK しないまま MAX + 1 件完了させる。
    for (let i = 0; i < MAX + 1; i += 1) {
      const response = await app.request(
        '/api/chat/message',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'p', message: `message ${i}` }),
        }),
        LOCAL_ENV,
      );
      expect(response.status).toBe(200);
    }

    // 先頭 (最古) が押し出されているので、次に配られるのは2番目。
    expect(await (await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV)).json())
      .toEqual(expect.objectContaining({ state: 'completed', sessionId: sessionIdFor(1) }));

    // 落ちた分を ACK しても壊れない (該当が無いので no-op)。
    const ackDropped = await app.request(
      `/api/chat/turn-status?projectId=p&sessionId=${sessionIdFor(0)}`,
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(ackDropped.status).toBe(204);
    expect(await (await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV)).json())
      .toEqual(expect.objectContaining({ state: 'completed', sessionId: sessionIdFor(1) }));
  });

  it('acknowledges only the named session and leaves the other completions queued', async () => {
    const sessionA = '550e8400-e29b-41d4-a716-4466554400aa';
    const sessionB = '550e8400-e29b-41d4-a716-4466554400bb';
    let call = 0;
    const sendMessage = vi.fn(async () => {
      call += 1;
      return {
        reply: `reply ${call}`,
        sessionId: call === 1 ? sessionA : sessionB,
        agentId: 'test-agent',
        failedTools: [],
      };
    });
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: createFakeAgent({ sendMessage }), cache, now: () => NOW });
    for (const message of ['thread A', 'thread B']) {
      const res = await app.request(
        '/api/chat/message',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'p', message }),
        }),
        LOCAL_ENV,
      );
      expect(res.status).toBe(200);
    }

    // 後ろの1件だけ ACK しても、先頭は残る。
    const ackB = await app.request(
      `/api/chat/turn-status?projectId=p&sessionId=${sessionB}`,
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(ackB.status).toBe(204);
    expect(await (await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV)).json())
      .toEqual(expect.objectContaining({ state: 'completed', sessionId: sessionA }));
  });

  it('includes sessionId in processing turn-status for an existing session turn', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    let resolveAgent: (result: ChatTurnResult) => void = () => {};
    const sendMessage = vi.fn(
      async (): Promise<ChatTurnResult> =>
        await new Promise<ChatTurnResult>((resolve) => {
          resolveAgent = resolve;
        }),
    );
    const store = createChatSessionStore();
    store.remember('p', sessionId, 'test-agent');
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({
      agent: createFakeAgent({ sendMessage }),
      cache,
      store,
      now: () => NOW,
    });
    const controller = new AbortController();
    const responsePromise = app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', sessionId, message: 'follow-up question' }),
        signal: controller.signal,
      }),
      LOCAL_ENV,
    );

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    controller.abort();
    const processing = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await processing.json()).toEqual({
      state: 'processing',
      message: 'follow-up question',
      agentId: 'test-agent',
      sessionId,
    });

    resolveAgent({
      reply: 'reply to existing session',
      sessionId,
      agentId: 'test-agent',
      failedTools: [],
    });
    await responsePromise;
  });
});

describe('createChatRoutes behavior', () => {
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

  it('returns 400 for invalid request body', async () => {
    const app = createApp();

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: '', message: 'hi' }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request body' });
  });

  it.each([
    ['unsupported GIF MIME', { mimeType: 'image/gif', data: 'R0lGODlh' }],
    ['non-strict base64', { mimeType: 'image/png', data: `${PNG_BASE64}\n` }],
    ['MIME/magic mismatch', { mimeType: 'image/jpeg', data: PNG_BASE64 }],
  ])('returns 400 for %s image input', async (_label, image) => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      cache,
      agent: createFakeAgent({
        descriptor: { ...createFakeAgent().descriptor, supportsImages: true },
      }),
    });
    const res = await app.request('/api/chat/message', withLocalHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-a', message: 'look', images: [image] }),
    }), LOCAL_ENV);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request body' });
  });

  it('returns JSON 413 before parsing a body over the 15 MiB transport limit', async () => {
    const app = createApp();
    const res = await app.request('/api/chat/message', withLocalHost({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(15 * 1024 * 1024 + 1),
      },
      body: '{}',
    }), LOCAL_ENV);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'request body too large' });
  });

  it('decodes bulk images, allows an empty message, and passes the fixed prompt to the agent', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const imageAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsImages: true },
    });
    const app = createApp({ cache, agent: imageAgent });
    const res = await app.request('/api/chat/message', withLocalHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-a',
        message: '',
        images: [{ mimeType: 'image/png', data: PNG_BASE64 }],
      }),
    }), LOCAL_ENV);

    expect(res.status).toBe(200);
    const request = vi.mocked(imageAgent.sendMessage).mock.calls[0]?.[0];
    expect(request?.message).toBe('添付画像の内容を説明してください。');
    expect(request?.images?.[0]?.mimeType).toBe('image/png');
    expect([...request!.images![0]!.data]).toEqual(PNG_BYTES);
  });

  it.each(['/api/chat/message', '/api/chat/message/stream'])(
    'returns the fixed image-not-supported 400 from %s before invoking the agent',
    async (endpoint) => {
      const cache = createFakeBoardCache([
        cachedProject(project('proj-a', '/projects/a')),
      ]);
      const unsupportedAgent = createFakeAgent({
        descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
        sendMessageStream: vi.fn(),
      });
      const app = createApp({ cache, agent: unsupportedAgent });
      const res = await app.request(endpoint, withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-a',
          message: 'look',
          images: [{ mimeType: 'image/png', data: PNG_BASE64 }],
        }),
      }), LOCAL_ENV);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'chat agent does not support image attachments',
      });
      expect(unsupportedAgent.sendMessage).not.toHaveBeenCalled();
      expect(unsupportedAgent.sendMessageStream).not.toHaveBeenCalled();
    },
  );

  it.each(['/api/chat/message', '/api/chat/message/stream'])(
    'keeps an unacknowledged completed turn when %s rejects an unsupported image',
    async (endpoint) => {
      const cache = createFakeBoardCache([
        cachedProject(project('proj-a', '/projects/a')),
      ]);
      const unsupportedAgent = createFakeAgent({
        descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
        sendMessageStream: vi.fn(),
      });
      const app = createApp({ cache, agent: unsupportedAgent });
      const completedResponse = await app.request('/api/chat/message', withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', message: 'first turn' }),
      }), LOCAL_ENV);
      const completedBody = await completedResponse.json() as { sessionId: string };

      const rejected = await app.request(endpoint, withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-a',
          message: 'look',
          images: [{ mimeType: 'image/png', data: PNG_BASE64 }],
        }),
      }), LOCAL_ENV);
      expect(rejected.status).toBe(400);

      const status = await app.request(
        '/api/chat/turn-status?projectId=proj-a',
        withLocalHost({}),
        LOCAL_ENV,
      );
      expect(await status.json()).toEqual(expect.objectContaining({
        state: 'completed',
        sessionId: completedBody.sessionId,
      }));
    },
  );

  it('returns 404 when the project is unknown', async () => {
    const app = createApp();

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'missing', message: 'hi' }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'project not found' });
  });

  it('returns 409 when chat is busy for the project', async () => {
    const store = createChatSessionStore();
    store.tryAcquire('proj-a');
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({ cache, store });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'chat is busy for this project',
    });
  });

  it('returns 502 when the agent fails', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      cache,
      agent: createFakeAgent({
        sendMessage: vi.fn(async () => {
          throw new ChatAgentError('agent-exit-nonzero');
        }),
      }),
    });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'chat failed',
      code: 'agent-exit-nonzero',
      detail: CHAT_FAILURE_MESSAGES['agent-exit-nonzero'],
    });
  });

  it('returns 200 with reply and sessionId on success', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({ cache });

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
    expect(await res.json()).toEqual({
      reply: 'hello from agent',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      agentId: 'test-agent',
    });
  });

  it('returns failedTools in the response when the agent reports failed tool calls (bdboard-l1t.4 MF3)', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      cache,
      agent: createFakeAgent({
        sendMessage: vi.fn(async () => ({
          reply: 'hello from agent',
          sessionId: '550e8400-e29b-41d4-a716-446655440099',
          failedTools: ['bd_ready'],
          agentId: 'test-agent',
        })),
      }),
    });

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
    expect(await res.json()).toEqual({
      reply: 'hello from agent',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      agentId: 'test-agent',
      failedTools: ['bd_ready'],
    });
  });

  it('returns agentWarnings in the response when the agent reports operational warnings (bdboard-l1t.6 N-e)', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      cache,
      agent: createFakeAgent({
        sendMessage: vi.fn(async () => ({
          reply: 'partial from agent',
          sessionId: '550e8400-e29b-41d4-a716-446655440099',
          failedTools: [],
          agentWarnings: [
            'headless auto-deny: some tool call(s) were soft-denied mid-turn',
          ],
          agentId: 'test-agent',
        })),
      }),
    });

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
    expect(await res.json()).toEqual({
      reply: 'partial from agent',
      sessionId: '550e8400-e29b-41d4-a716-446655440099',
      agentId: 'test-agent',
      agentWarnings: [
        'headless auto-deny: some tool call(s) were soft-denied mid-turn',
      ],
    });
  });

  it('returns 400 for unknown chat session', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({ cache });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-a',
          message: 'hi',
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown chat session' });
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

const CHAT_ROUTES_SOURCE = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'chat-routes.ts',
  ),
  'utf8',
);

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

describe('chat sessionId validation and agentId (bdboard-l1t.2 step 2)', () => {
  it('resumes a non-UUID sessionId when the store knows it', async () => {
    const sendMessage = vi.fn(async () => ({
      reply: 'resumed',
      sessionId: 'sess_not-a-uuid',
      failedTools: [],
      agentId: 'claude',
    }));
    const agent = createFakeAgent({
      descriptor: {
        id: 'claude',
        label: 'Claude',
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        experimental: false,
        capability: 'bd-only',
      },
      sendMessage,
    });
    const store = createChatSessionStore();
    store.remember('proj-a', 'sess_not-a-uuid', 'claude');
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({ cache, store, agent });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-a',
          message: 'continue',
          sessionId: 'sess_not-a-uuid',
        }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: 'sess_not-a-uuid' }),
    );
  });

  it.each([
    ['201 characters', 'x'.repeat(201)],
    ['control character', 'a\u0000b'],
    ['newline', 'line1\nline2'],
  ])('returns 400 for invalid sessionId (%s)', async (_label, sessionId) => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({ cache });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-a',
          message: 'hi',
          sessionId,
        }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request body' });
  });

  it('does not use .uuid() in chat-routes.ts', () => {
    expect(CHAT_ROUTES_SOURCE.includes('.uuid(')).toBe(false);
  });

  it('returns agentId on success when agentId is specified for a new turn', async () => {
    const sendMessage = vi.fn(async () => ({
      reply: 'from codex',
      sessionId: 'new-session-id',
      failedTools: [],
      agentId: 'codex',
    }));
    const claude = createFakeAgent({
      descriptor: {
        id: 'claude',
        label: 'Claude',
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        experimental: false,
        capability: 'bd-only',
      },
    });
    const codex = createFakeAgent({
      descriptor: {
        id: 'codex',
        label: 'Codex',
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        experimental: false,
        capability: 'reads-project',
      },
      sendMessage,
    });
    const registry = createChatAgentRegistry();
    registry.register(claude);
    registry.register(codex);
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({ cache, agents: registry });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-a',
          message: 'hi',
          agentId: 'codex',
        }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reply: 'from codex',
      sessionId: 'new-session-id',
      agentId: 'codex',
    });
    expect(sendMessage).toHaveBeenCalled();
  });

  it('returns 400 for an unknown agentId', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({ cache });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-a',
          message: 'hi',
          agentId: 'missing-agent',
        }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'unknown chat agent',
      detail: 'unknown chat agent',
    });
  });

  it('returns 400 when resuming with a mismatched agentId', async () => {
    const store = createChatSessionStore();
    store.remember('proj-a', 'sess-1', 'claude');
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({ cache, store });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-a',
          message: 'hi',
          sessionId: 'sess-1',
          agentId: 'other',
        }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'chat agent mismatch',
      detail: 'session belongs to agent claude',
    });
  });

  it('returns 503 when the agent CLI cannot be started', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      cache,
      agent: createFakeAgent({
        sendMessage: vi.fn(async () => {
          throw new ChatAgentError('agent-not-found');
        }),
      }),
    });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'chat agent unavailable',
      detail: CHAT_FAILURE_MESSAGES['agent-not-found'],
    });
  });

  it('returns 400 for an unknown model', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      cache,
      agent: createFakeAgent({
        descriptor: {
          id: 'claude',
          label: 'Claude',
          model: 'sonnet',
          models: [
            { id: 'sonnet', label: 'Sonnet' },
            { id: 'opus', label: 'Opus' },
          ],
          experimental: false,
          capability: 'bd-only',
        },
      }),
    });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-a',
          message: 'hi',
          model: 'haiku',
        }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'unknown chat model',
      detail: 'unknown chat model',
    });
  });

  it('returns model on success when an allowed model is specified', async () => {
    const sendMessage = vi.fn(async () => ({
      reply: 'from opus',
      sessionId: 'new-session-id',
      failedTools: [],
      agentId: 'claude',
      model: 'opus',
    }));
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({
      cache,
      agent: createFakeAgent({
        descriptor: {
          id: 'claude',
          label: 'Claude',
          model: 'sonnet',
          models: [
            { id: 'sonnet', label: 'Sonnet' },
            { id: 'opus', label: 'Opus' },
          ],
          experimental: false,
          capability: 'bd-only',
        },
        sendMessage,
      }),
    });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-a',
          message: 'hi',
          model: 'opus',
        }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reply: 'from opus',
      sessionId: 'new-session-id',
      agentId: 'claude',
      model: 'opus',
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'opus' }),
    );
  });

  it('returns persisted session messages for a known session', async () => {
    const store = createChatSessionStore();
    const messages = createInMemoryChatMessageRepository();
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    store.remember('proj-a', sessionId, 'test-agent');
    messages.append(sessionId, [
      { role: 'user', content: 'hello', createdAt: NOW },
      { role: 'assistant', content: 'hi there', createdAt: NOW },
    ]);

    const app = createApp({ store, messages });
    const res = await app.request(
      `/api/chat/sessions/${sessionId}/messages?projectId=proj-a`,
      withLocalHost({ method: 'GET' }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId,
      agentId: 'test-agent',
      messages: [
        {
          role: 'user',
          content: 'hello',
          createdAt: NOW.toISOString(),
        },
        {
          role: 'assistant',
          content: 'hi there',
          createdAt: NOW.toISOString(),
        },
      ],
    });
  });

  it('lists chat threads for the requested project only', async () => {
    const store = createChatSessionStore();
    const messages = createInMemoryChatMessageRepository();
    const sessionA = '550e8400-e29b-41d4-a716-446655440099';
    const sessionB = '550e8400-e29b-41d4-a716-446655440098';
    store.remember('proj-a', sessionA, 'claude');
    store.remember('proj-b', sessionB, 'claude');
    messages.append(sessionA, [{ role: 'user', content: 'project A title' }]);
    messages.append(sessionB, [{ role: 'user', content: 'project B title' }]);

    const app = createApp({ store, messages });
    const res = await app.request('/api/chat/threads?projectId=proj-a', withLocalHost({}), LOCAL_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      expect.objectContaining({ sessionId: sessionA, agentId: 'claude', title: 'project A title', pinned: false }),
    ]);
  });

  it('patches a chat thread title and pinned state', async () => {
    const store = createChatSessionStore();
    const messages = createInMemoryChatMessageRepository();
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    store.remember('proj-a', sessionId, 'claude');
    messages.append(sessionId, [{ role: 'user', content: 'auto title from first message', createdAt: NOW }]);
    const app = createApp({ store, messages });

    const renamed = await app.request(
      `/api/chat/sessions/${sessionId}/thread`,
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', title: '  運用相談  ' }),
      }),
      LOCAL_ENV,
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({
      sessionId,
      agentId: 'claude',
      title: '運用相談',
      pinned: false,
      updatedAt: NOW.toISOString(),
    });

    const pinned = await app.request(
      `/api/chat/sessions/${sessionId}/thread`,
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', pinned: true }),
      }),
      LOCAL_ENV,
    );
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toEqual({
      sessionId,
      agentId: 'claude',
      title: '運用相談',
      pinned: true,
      updatedAt: NOW.toISOString(),
    });

    const cleared = await app.request(
      `/api/chat/sessions/${sessionId}/thread`,
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', title: null }),
      }),
      LOCAL_ENV,
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      sessionId,
      agentId: 'claude',
      title: 'auto title from first message',
      pinned: true,
      updatedAt: NOW.toISOString(),
    });
  });

  it('rejects invalid thread patch requests', async () => {
    const store = createChatSessionStore();
    const messages = createInMemoryChatMessageRepository();
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    store.remember('proj-a', sessionId, 'claude');
    const app = createApp({ store, messages });

    const invalidSession = await app.request(
      '/api/chat/sessions/-rf/thread',
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', title: 'x' }),
      }),
      LOCAL_ENV,
    );
    expect(invalidSession.status).toBe(400);
    expect(await invalidSession.json()).toEqual({ error: 'invalid session id' });

    const unknown = await app.request(
      `/api/chat/sessions/550e8400-e29b-41d4-a716-446655440098/thread`,
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', title: 'x' }),
      }),
      LOCAL_ENV,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown chat session' });

    const emptyPatch = await app.request(
      `/api/chat/sessions/${sessionId}/thread`,
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a' }),
      }),
      LOCAL_ENV,
    );
    expect(emptyPatch.status).toBe(400);
    expect(await emptyPatch.json()).toEqual({ error: 'invalid request body' });

    const blankTitle = await app.request(
      `/api/chat/sessions/${sessionId}/thread`,
      withLocalHost({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', title: '   ' }),
      }),
      LOCAL_ENV,
    );
    expect(blankTitle.status).toBe(400);
    expect(await blankTitle.json()).toEqual({ error: 'invalid request body' });
  });

  it('requires projectId and keeps thread listing behind the chat guard', async () => {
    const app = createApp();
    expect((await app.request('/api/chat/threads', withLocalHost({}), LOCAL_ENV)).status).toBe(400);
    expect((await app.request('/api/chat/threads?projectId=proj-a', withLocalHost({ headers: { 'CF-Ray': 'remote' } }), LOCAL_ENV)).status).toBe(403);
  });

  it('deletes both the session and its messages, rejects unknown and cross-project sessions', async () => {
    const store = createChatSessionStore();
    const messages = createInMemoryChatMessageRepository();
    const sessionA = '550e8400-e29b-41d4-a716-446655440099';
    const sessionB = '550e8400-e29b-41d4-a716-446655440098';
    store.remember('proj-a', sessionA, 'claude');
    store.remember('proj-b', sessionB, 'claude');
    messages.append(sessionA, [{ role: 'user', content: 'delete' }]);
    messages.append(sessionB, [{ role: 'user', content: 'keep' }]);
    const app = createApp({ store, messages });

    const deleted = await app.request(`/api/chat/sessions/${sessionA}?projectId=proj-a`, withLocalHost({ method: 'DELETE' }), LOCAL_ENV);
    expect(deleted.status).toBe(204);
    expect((await app.request(`/api/chat/sessions/${sessionA}/messages?projectId=proj-a`, withLocalHost({}), LOCAL_ENV)).status).toBe(404);
    expect(messages.listBySession(sessionA)).toEqual([]);
    expect(messages.listBySession(sessionB)).toHaveLength(1);

    const unknown = await app.request(`/api/chat/sessions/${sessionA}?projectId=proj-a`, withLocalHost({ method: 'DELETE' }), LOCAL_ENV);
    expect(unknown.status).toBe(404);
    const crossProject = await app.request(`/api/chat/sessions/${sessionB}?projectId=proj-a`, withLocalHost({ method: 'DELETE' }), LOCAL_ENV);
    expect(crossProject.status).toBe(404);
    expect(messages.listBySession(sessionB)).toHaveLength(1);
  });

  it('includes the persisted model when fetching session messages', async () => {
    const store = createChatSessionStore();
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    store.remember('proj-a', sessionId, 'test-agent');
    store.updateModel('proj-a', sessionId, 'opus');

    const app = createApp({ store });
    const res = await app.request(
      `/api/chat/sessions/${sessionId}/messages?projectId=proj-a`,
      withLocalHost({ method: 'GET' }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId, agentId: 'test-agent', model: 'opus', messages: [],
    });
  });

  it('omits the model when it has not been persisted', async () => {
    const store = createChatSessionStore();
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    store.remember('proj-a', sessionId, 'test-agent');

    const app = createApp({ store });
    const res = await app.request(
      `/api/chat/sessions/${sessionId}/messages?projectId=proj-a`,
      withLocalHost({ method: 'GET' }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId, agentId: 'test-agent', messages: [],
    });
  });

  it('persists and returns failedTools when fetching session messages (bdboard-ftn)', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const messages = createInMemoryChatMessageRepository();
    const app = createApp({
      cache,
      messages,
      agent: createFakeAgent({
        sendMessage: vi.fn(async () => ({
          reply: 'hello from agent',
          sessionId: '550e8400-e29b-41d4-a716-446655440099',
          failedTools: ['bd_ready'],
          agentId: 'test-agent',
        })),
      }),
    });

    const sendRes = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      LOCAL_ENV,
    );
    expect(sendRes.status).toBe(200);
    const sendBody = await sendRes.json();
    expect(sendBody.failedTools).toEqual(['bd_ready']);

    const getRes = await app.request(
      `/api/chat/sessions/${sendBody.sessionId}/messages?projectId=proj-a`,
      withLocalHost({ method: 'GET' }),
      LOCAL_ENV,
    );
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.messages).toEqual([
      { role: 'user', content: 'hi', createdAt: expect.any(String) },
      {
        role: 'assistant',
        content: 'hello from agent',
        createdAt: expect.any(String),
        failedTools: ['bd_ready'],
      },
    ]);
  });

  it('persists and returns agentWarnings when fetching session messages (bdboard-l1t.6 N-e)', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const messages = createInMemoryChatMessageRepository();
    const app = createApp({
      cache,
      messages,
      agent: createFakeAgent({
        sendMessage: vi.fn(async () => ({
          reply: 'partial from agent',
          sessionId: '550e8400-e29b-41d4-a716-446655440099',
          failedTools: [],
          agentWarnings: [
            'headless auto-deny: some tool call(s) were soft-denied mid-turn',
          ],
          agentId: 'test-agent',
        })),
      }),
    });

    const sendRes = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      LOCAL_ENV,
    );
    expect(sendRes.status).toBe(200);
    const sendBody = await sendRes.json();
    expect(sendBody.agentWarnings).toEqual([
      'headless auto-deny: some tool call(s) were soft-denied mid-turn',
    ]);

    const getRes = await app.request(
      `/api/chat/sessions/${sendBody.sessionId}/messages?projectId=proj-a`,
      withLocalHost({ method: 'GET' }),
      LOCAL_ENV,
    );
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.messages).toEqual([
      { role: 'user', content: 'hi', createdAt: expect.any(String) },
      {
        role: 'assistant',
        content: 'partial from agent',
        createdAt: expect.any(String),
        agentWarnings: [
          'headless auto-deny: some tool call(s) were soft-denied mid-turn',
        ],
      },
    ]);
  });

  it('omits failedTools when the agent reports no failures (bdboard-ftn)', async () => {
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const messages = createInMemoryChatMessageRepository();
    const app = createApp({
      cache,
      messages,
      agent: createFakeAgent({
        sendMessage: vi.fn(async () => ({
          reply: 'clean reply',
          sessionId: '550e8400-e29b-41d4-a716-446655440099',
          failedTools: [],
          agentId: 'test-agent',
        })),
      }),
    });

    const sendRes = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', message: 'hi' }),
      }),
      LOCAL_ENV,
    );
    expect(sendRes.status).toBe(200);
    const sendBody = await sendRes.json();
    expect(sendBody).not.toHaveProperty('failedTools');

    const getRes = await app.request(
      `/api/chat/sessions/${sendBody.sessionId}/messages?projectId=proj-a`,
      withLocalHost({ method: 'GET' }),
      LOCAL_ENV,
    );
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.messages).toEqual([
      { role: 'user', content: 'hi', createdAt: expect.any(String) },
      { role: 'assistant', content: 'clean reply', createdAt: expect.any(String) },
    ]);
    expect(getBody.messages[1]).not.toHaveProperty('failedTools');
  });

  it('returns 404 when fetching messages for an unknown session', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/chat/sessions/550e8400-e29b-41d4-a716-446655440099/messages?projectId=proj-a',
      withLocalHost({ method: 'GET' }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown chat session' });
  });

  it('stores messages when posting a chat message', async () => {
    const messages = createInMemoryChatMessageRepository();
    const cache = createFakeBoardCache([
      cachedProject(project('proj-a', '/projects/a')),
    ]);
    const app = createApp({ cache, messages });

    const res = await app.request(
      '/api/chat/message',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-a', message: 'question' }),
      }),
      LOCAL_ENV,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(messages.listBySession(body.sessionId)).toEqual([
      { role: 'user', content: 'question', createdAt: expect.any(Date) },
      {
        role: 'assistant',
        content: 'hello from agent',
        createdAt: expect.any(Date),
      },
    ]);
  });

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
