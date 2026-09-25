import { describe, expect, it, vi, afterEach } from 'vitest';
import { ChatAgentError, CHAT_FAILURE_MESSAGES, type ChatTurnResult } from '../../application/ports/chat-agent.js';
import { createChatSessionStore } from '../../application/chat/chat-session-store.js';
import { createInMemoryChatMessageRepository } from '../../application/chat/in-memory-chat-message-repository.js';
import { CHAT_STREAM_QUEUE_MAX_SIZE } from './chat-routes.js';
import {
  LOCAL_ENV,
  NOW,
  PNG_BASE64,
  PNG_BYTES,
  cachedProject,
  createApp,
  createFakeAgent,
  createFakeBoardCache,
  project,
  withLocalHost,
} from './chat-routes-test-support.js';

// bdboard-sso1.31: chat-routes.test.ts (chat ルート総合テスト) を実装側の chat
// ルートモジュール分割 (bdboard-sso1.17) に追随させて move-only 分割した一部
// (POST /api/chat/message/stream)。テスト本体・期待値・モックの記述は元の
// chat-routes.test.ts から一字一句変更していない。
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

  it('stops delivery to a stalled client on queue overflow, still finalizes the turn, and releases the lock', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440066';
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (_request, onDelta) => {
        // The response body is not read during the turn, so real Hono backpressure applies:
        // 'first' fills the body's one-chunk buffer and the writer stalls inside writeSSE on
        // 'second'. The burst then overflows the queue while that write is still stalled.
        onDelta({ text: 'first' });
        onDelta({ text: 'second' });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        for (let index = 0; index <= CHAT_STREAM_QUEUE_MAX_SIZE; index += 1) {
          onDelta({ text: `burst-${index}` });
        }
        return { reply: 'final reply', sessionId, agentId: 'test-agent', failedTools: [] };
      }),
    });
    const store = createChatSessionStore();
    const rememberSpy = vi.spyOn(store, 'remember');
    const messages = createInMemoryChatMessageRepository();
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: streamingAgent, cache, store, messages });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const response = await app.request(
        '/api/chat/message/stream',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'p', message: 'hello' }),
        }),
        LOCAL_ENV,
      );
      expect(response.status).toBe(200);

      await vi.waitFor(() =>
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('per-client queue limit')),
      );
      await vi.waitFor(() =>
        expect(rememberSpy).toHaveBeenCalledWith('p', sessionId, 'test-agent'),
      );
      expect(messages.listBySession(sessionId)).toEqual([
        expect.objectContaining({ role: 'user', content: 'hello' }),
        expect.objectContaining({ role: 'assistant', content: 'final reply' }),
      ]);

      // Still without reading the body: only the overflow abort can unblock the stalled
      // write. Without it the writer loop never reaches its finally and the per-project
      // chat lock stays held, so this follow-up would get 409.
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

      const text = await response.text();
      expect(text).toContain('"text":"first"');
      expect(text).not.toContain('burst-');
      expect(text).not.toContain('event: done');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('releases the chat lock when a short turn settles even if the client stalls below the queue limit (bdboard-pti0)', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440055';
    const stallText = 'x'.repeat(256 * 1024);
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (_request, onDelta) => {
        // The body is never read, and the deltas are large enough that the writer stalls in
        // writeSSE whatever the response stream buffers. 'done' stays queued far below
        // CHAT_STREAM_QUEUE_MAX_SIZE, so the overflow abort never fires: before bdboard-pti0
        // the stalled writer held the lock. Now it is released at settle, before the writer
        // gets that far.
        onDelta({ text: `first-${stallText}` });
        onDelta({ text: `second-${stallText}` });
        return { reply: 'short reply', sessionId, agentId: 'test-agent', failedTools: [] };
      }),
    });
    const store = createChatSessionStore();
    const rememberSpy = vi.spyOn(store, 'remember');
    const releaseSpy = vi.spyOn(store, 'release');
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: streamingAgent, cache, store });

    const response = await app.request(
      '/api/chat/message/stream',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', message: 'hello' }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(rememberSpy).toHaveBeenCalledWith('p', sessionId, 'test-agent'));
    expect(store.isBusy('p')).toBe(false);
    expect(releaseSpy).toHaveBeenCalledTimes(1);

    // The stalled writer has not exited, yet the next turn for the project is accepted.
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
    expect(releaseSpy).toHaveBeenCalledTimes(2);

    // Delivery still completes once the client resumes reading.
    const text = await response.text();
    expect(text.match(/event: delta/g)).toHaveLength(2);
    expect(text.match(/event: done/g)).toHaveLength(1);
    expect(text).toContain('"reply":"short reply"');
    // The late writer exit must not release again.
    expect(releaseSpy).toHaveBeenCalledTimes(2);
  });

  it("does not release the next turn's lock when an earlier stalled stream writer exits late (bdboard-pti0)", async () => {
    const firstSessionId = '550e8400-e29b-41d4-a716-446655440044';
    const secondSessionId = '550e8400-e29b-41d4-a716-446655440033';
    const stallText = 'x'.repeat(256 * 1024);
    let resolveSecond: (result: ChatTurnResult) => void = () => {};
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (_request, onDelta) => {
        onDelta({ text: `first-${stallText}` });
        onDelta({ text: `second-${stallText}` });
        return { reply: 'first reply', sessionId: firstSessionId, agentId: 'test-agent', failedTools: [] };
      }),
      sendMessage: vi.fn(
        async (): Promise<ChatTurnResult> =>
          await new Promise<ChatTurnResult>((resolve) => {
            resolveSecond = resolve;
          }),
      ),
    });
    const store = createChatSessionStore();
    const rememberSpy = vi.spyOn(store, 'remember');
    const releaseSpy = vi.spyOn(store, 'release');
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: streamingAgent, cache, store });
    const post = (route: string, message: string): Promise<Response> =>
      Promise.resolve(
        app.request(
          route,
          withLocalHost({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: 'p', message }),
          }),
          LOCAL_ENV,
        ),
      );

    // Turn 1 settles while its client is stalled (body unread).
    const firstResponse = await post('/api/chat/message/stream', 'turn 1');
    expect(firstResponse.status).toBe(200);
    await vi.waitFor(() => expect(rememberSpy).toHaveBeenCalledWith('p', firstSessionId, 'test-agent'));
    expect(releaseSpy).toHaveBeenCalledTimes(1);

    // Turn 2 acquires the lock and stays in flight.
    const secondPromise = post('/api/chat/message', 'turn 2');
    await vi.waitFor(() => expect(streamingAgent.sendMessage).toHaveBeenCalled());
    expect(store.isBusy('p')).toBe(true);

    // Turn 1's client resumes, so its writer loop finally exits. That exit must not
    // call store.release (locks.delete) and free turn 2's lock.
    const firstText = await firstResponse.text();
    expect(firstText).toContain('"reply":"first reply"');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(store.isBusy('p')).toBe(true);
    const blocked = await post('/api/chat/message', 'turn 3');
    expect(blocked.status).toBe(409);

    resolveSecond({ reply: 'second reply', sessionId: secondSessionId, agentId: 'test-agent', failedTools: [] });
    const secondResponse = await secondPromise;
    expect(secondResponse.status).toBe(200);
    expect(releaseSpy).toHaveBeenCalledTimes(2);
    expect(store.isBusy('p')).toBe(false);
  });

  it('does not leave an unhandled rejection when finalize throws while the writer is stalled (bdboard-gwxz)', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440066';
    const stallText = 'x'.repeat(256 * 1024);
    const finalizeFailure = new Error('remember failed');
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (_request, onDelta) => {
        // Unread body + large deltas: the writer stalls in writeSSE, so it has not reached
        // `await turnPromise` when runTurn rejects below.
        onDelta({ text: `first-${stallText}` });
        onDelta({ text: `second-${stallText}` });
        return { reply: 'never delivered', sessionId, agentId: 'test-agent', failedTools: [] };
      }),
    });
    const store = createChatSessionStore();
    // store.remember throwing makes finalizeChatTurnSuccess throw a non-ChatAgentError,
    // which runTurn rethrows.
    const rememberSpy = vi.spyOn(store, 'remember').mockImplementation(() => {
      throw finalizeFailure;
    });
    const releaseSpy = vi.spyOn(store, 'release');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
      const app = createApp({ agent: streamingAgent, cache, store });

      const response = await app.request(
        '/api/chat/message/stream',
        withLocalHost({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'p', message: 'hello' }),
        }),
        LOCAL_ENV,
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(rememberSpy).toHaveBeenCalled());
      // Node reports unhandled rejections once the microtask queue drains, so give it a
      // few macrotask turns while the writer is still stalled.
      for (let turn = 0; turn < 3; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // The writer is still stalled: had it reached `await turnPromise`, the rethrow would
      // already have reached streamSSE's console.error.
      expect(consoleError).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
      // The lock is still released on the throw path, and since finalize threw nothing
      // was recorded as completed.
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(store.isBusy('p')).toBe(false);
      const status = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
      expect(await status.json()).toEqual({ state: 'idle' });

      // Once the client reads, the writer drains the deltas and `await turnPromise` still
      // propagates the error to streamSSE; no 'done' is sent.
      const text = await response.text();
      expect(text.match(/event: delta/g)).toHaveLength(2);
      expect(text).not.toContain('event: done');
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(finalizeFailure));
      expect(unhandled).toEqual([]);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      consoleError.mockRestore();
    }
  });

  it('records the completed turn before releasing the lock, so turn-status never reads idle in between (bdboard-gwxz)', async () => {
    // web's ChatPanel detects a finished turn by turn-status going straight from
    // processing to completed (PR #467). Releasing first would open an idle window.
    const sessionId = '550e8400-e29b-41d4-a716-446655440077';
    const events: string[] = [];
    const now = vi.fn(() => {
      events.push('now');
      return NOW;
    });
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async () => ({
        reply: 'ordered reply',
        sessionId,
        agentId: 'test-agent',
        failedTools: [],
      })),
    });
    const store = createChatSessionStore();
    const originalRelease = store.release.bind(store);
    const releaseSpy = vi.spyOn(store, 'release').mockImplementation((projectId: string) => {
      events.push('release');
      originalRelease(projectId);
    });
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: streamingAgent, cache, store, now });

    const response = await app.request(
      '/api/chat/message/stream',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', message: 'hello' }),
      }),
      LOCAL_ENV,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"reply":"ordered reply"');

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    // recordCompletedTurn stamps completedAt via now(); that must happen before release.
    // The now() call is a proxy for the record itself: completedTurns is not observable
    // synchronously, so hoisting only the timestamp above release would slip past this.
    expect(events.lastIndexOf('now')).toBeGreaterThanOrEqual(0);
    expect(events.lastIndexOf('now')).toBeLessThan(events.indexOf('release'));
    const status = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await status.json()).toEqual({
      state: 'completed',
      sessionId,
      agentId: 'test-agent',
      completedAt: NOW.toISOString(),
    });
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

  it('stops delivery on queue overflow even for a client actively draining the stream (bdboard-rrvr)', async () => {
    // Unlike the "stalled client" overflow test above, nothing here artificially keeps
    // the response body unread: res.text() actively drains the stream as it arrives, so
    // this exercises the overflow-while-actively-reading regime separately from the
    // overflow-while-stalled regime (bdboard-rrvr removed the 'detached' SSE event this
    // test used to assert on; the surrounding delivery-stop behavior it also covered is
    // kept here so that regime isn't left with only the stalled-client test).
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (_request, onDelta) => {
        for (let index = 0; index <= CHAT_STREAM_QUEUE_MAX_SIZE; index += 1) {
          onDelta({ text: `burst-${index}` });
        }
        return { reply: 'final reply', sessionId: '550e8400-e29b-41d4-a716-446655440091', agentId: 'test-agent', failedTools: [] };
      }),
    });
    const app = createApp({
      agent: streamingAgent,
      cache: createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await app.request('/api/chat/message/stream', withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', message: 'hello' }),
      }), LOCAL_ENV);
      expect(res.status).toBe(200);
      const text = await res.text();
      // Delivery stopped at the overflow: the turn's own 'done' never reaches this
      // client (it still finalizes server-side; that is covered by the existing
      // "stops delivery..." stalled-client test above).
      expect(text).not.toContain('event: done');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('per-client queue limit'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reports a failed turn via turn-status and clears it on ack, alongside the SSE error event a connected client already sees (bdboard-3tw.165)', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440092';
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (): Promise<ChatTurnResult> => {
        throw new ChatAgentError('agent-timeout');
      }),
    });
    const store = createChatSessionStore();
    store.remember('p', sessionId, 'test-agent');
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: streamingAgent, cache, store, now: () => NOW });

    const res = await app.request('/api/chat/message/stream', withLocalHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', sessionId, message: 'hello' }),
    }), LOCAL_ENV);
    expect(res.status).toBe(200);
    await res.text();

    const status = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await status.json()).toEqual({
      state: 'failed',
      code: 'agent-timeout',
      agentId: 'test-agent',
      sessionId,
      failedAt: NOW.toISOString(),
    });

    const ack = await app.request(
      `/api/chat/turn-status?projectId=p&sessionId=${sessionId}`,
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(ack.status).toBe(204);
    const idle = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await idle.json()).toEqual({ state: 'idle' });
  });

  it('reports a failed turn via turn-status when the agent fails after the client disconnects, without the idle inference (bdboard-3tw.165)', async () => {
    // This is the ticket's core scenario: bdboard-3tw.164's web recovery previously had
    // to infer failure from turn-status going straight from processing to idle. Here the
    // server records it explicitly instead, so turn-status never has to fall through to
    // 'idle' for this case.
    const sessionId = '550e8400-e29b-41d4-a716-446655440093';
    let rejectAgent: (err: unknown) => void = () => {};
    let sendMessageStreamCalled = false;
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(
        async (): Promise<ChatTurnResult> => {
          sendMessageStreamCalled = true;
          return await new Promise<ChatTurnResult>((_resolve, reject) => {
            rejectAgent = reject;
          });
        },
      ),
    });
    const store = createChatSessionStore();
    store.remember('p', sessionId, 'test-agent');
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: streamingAgent, cache, store, now: () => NOW });
    const controller = new AbortController();
    const responsePromise = app.request(
      '/api/chat/message/stream',
      withLocalHost({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p', sessionId, message: 'hello' }),
        signal: controller.signal,
      }),
      LOCAL_ENV,
    );

    await vi.waitFor(() => expect(sendMessageStreamCalled).toBe(true));
    controller.abort();
    await responsePromise;

    // The lock-release-ordering invariant (bdboard-pti0) applies here too: recordFailedTurn
    // runs synchronously in the same catch as release() (finally), with no await between
    // them, so there is no idle window to race even though this test's own vi.waitFor
    // polling below wouldn't itself catch a brief one if there were.
    rejectAgent(new ChatAgentError('agent-timeout'));

    await vi.waitFor(async () => {
      const status = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
      expect(await status.json()).toEqual({
        state: 'failed',
        code: 'agent-timeout',
        agentId: 'test-agent',
        sessionId,
        failedAt: NOW.toISOString(),
      });
    });

    // The lock must already be free too (release() and recordFailedTurn both happen in
    // the same catch/finally pass, same as the completed-turn path).
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

  it('prioritizes a session-scoped failed turn over an older sessionId-less one so it is not hidden behind it (bdboard-96rp)', async () => {
    // The failedTurns queue can hold a sessionId-less entry (a new thread's first send
    // failing before the agent hands back a sessionId) indefinitely -- there is no ACK
    // path for it (see FailedChatTurn's doc comment above), so unlike a session-scoped
    // entry it only ever leaves the queue via CHAT_COMPLETED_TURNS_MAX eviction. If GET
    // naively returned the oldest entry, a sessionId-less failure recorded first would
    // sit at the front and hide every later, ACK-able, session-scoped failure from any
    // client polling this project -- including one belonging to a completely different
    // session. Verify the session-scoped one still surfaces first.
    const sessionId = '550e8400-e29b-41d4-a716-446655440094';
    let call = 0;
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (): Promise<ChatTurnResult> => {
        call += 1;
        throw new ChatAgentError(call === 1 ? 'agent-timeout' : 'agent-exit-nonzero');
      }),
    });
    const store = createChatSessionStore();
    store.remember('p', sessionId, 'test-agent');
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: streamingAgent, cache, store, now: () => NOW });

    // 1st: a brand-new thread (no sessionId yet) fails -- recorded sessionId-less.
    const first = await app.request('/api/chat/message/stream', withLocalHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', message: 'doomed new thread' }),
    }), LOCAL_ENV);
    expect(first.status).toBe(200);
    await first.text();

    // 2nd: an existing, identified thread fails too -- recorded with its sessionId.
    const second = await app.request('/api/chat/message/stream', withLocalHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', sessionId, message: 'doomed existing thread' }),
    }), LOCAL_ENV);
    expect(second.status).toBe(200);
    await second.text();

    // Both entries are queued (oldest = sessionId-less), but the session-scoped one --
    // the only one a client can actually ACK -- must be the one GET surfaces.
    const status = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await status.json()).toEqual({
      state: 'failed',
      code: 'agent-exit-nonzero',
      agentId: 'test-agent',
      sessionId,
      failedAt: NOW.toISOString(),
    });

    // ACKing it drains only that entry; the still-unreachable sessionId-less one remains
    // queued behind (this was, at the time, the documented, unresolved half of the
    // constraint -- see FailedChatTurn's doc comment -- and out of this fix's scope; it is
    // now bounded by FAILED_TURN_SESSIONLESS_TTL_MS instead of lingering indefinitely,
    // see the bdboard-kg0m tests below).
    const ack = await app.request(
      `/api/chat/turn-status?projectId=p&sessionId=${sessionId}`,
      withLocalHost({ method: 'DELETE' }),
      LOCAL_ENV,
    );
    expect(ack.status).toBe(204);
    const afterAck = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await afterAck.json()).toEqual({
      state: 'failed',
      code: 'agent-timeout',
      agentId: 'test-agent',
      failedAt: NOW.toISOString(),
    });
  });

  it('replaces an older sessionId-less failed entry with a newer one instead of appending (bdboard-96rp B1, round 2 re-review)', async () => {
    // Round 2 Opus re-review finding B1: the fix above only reorders session-scoped vs.
    // sessionId-less entries -- it does nothing for two sessionId-less entries competing
    // with each other. Before this fix, recordFailedTurn appended a second sessionId-less
    // entry behind the first; since GET's selection falls back to failedQueue[0] among
    // sessionId-less entries (see the .find(...) ?? [0] above), the OLDER, un-ACKable
    // orphan would keep shadowing the newer one forever (no ack path exists for either).
    // recordFailedTurn must instead replace the old sessionId-less entry with the new one,
    // so GET always surfaces the newest sessionId-less failure.
    let call = 0;
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (): Promise<ChatTurnResult> => {
        call += 1;
        throw new ChatAgentError(call === 1 ? 'agent-timeout' : 'agent-exit-nonzero');
      }),
    });
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({ agent: streamingAgent, cache, store: createChatSessionStore(), now: () => NOW });

    // 1st: a brand-new thread fails, sessionId-less, un-ACKable, would sit forever.
    const first = await app.request('/api/chat/message/stream', withLocalHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', message: 'first doomed new thread' }),
    }), LOCAL_ENV);
    expect(first.status).toBe(200);
    await first.text();

    // 2nd: a DIFFERENT brand-new thread also fails, also sessionId-less.
    const second = await app.request('/api/chat/message/stream', withLocalHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', message: 'second doomed new thread' }),
    }), LOCAL_ENV);
    expect(second.status).toBe(200);
    await second.text();

    // Without the fix, GET would still return the 1st entry (agent-timeout) forever --
    // there is no way to ack it and let the 2nd become visible. With the fix, the 2nd
    // (newest) sessionId-less entry replaces the 1st and is what GET surfaces.
    const status = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await status.json()).toEqual({
      state: 'failed',
      code: 'agent-exit-nonzero',
      agentId: 'test-agent',
      failedAt: NOW.toISOString(),
    });
  });

  it('keeps a sessionId-less failed turn visible to GET until FAILED_TURN_SESSIONLESS_TTL_MS elapses (bdboard-kg0m)', async () => {
    // Regression guard for the TTL fix below: a sessionId-less failed entry must not be
    // pruned early. A genuinely-recovering client (e.g. one that lost its own connection
    // right when the stream detached) still needs to see this entry within the TTL window.
    let currentMs = 0;
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (): Promise<ChatTurnResult> => {
        throw new ChatAgentError('agent-timeout');
      }),
    });
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({
      agent: streamingAgent,
      cache,
      store: createChatSessionStore(),
      now: () => new Date(currentMs),
    });

    const send = await app.request('/api/chat/message/stream', withLocalHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', message: 'doomed new thread' }),
    }), LOCAL_ENV);
    expect(send.status).toBe(200);
    await send.text();

    // Just under the TTL (FAILED_TURN_SESSIONLESS_TTL_MS = 60_000): still visible.
    currentMs += 59_000;
    const status = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await status.json()).toEqual({
      state: 'failed',
      code: 'agent-timeout',
      agentId: 'test-agent',
      failedAt: new Date(0).toISOString(),
    });
  });

  it('prunes an expired sessionId-less failed turn instead of leaving an uninvolved poller stuck forever (bdboard-kg0m)', async () => {
    // bdboard-kg0m: a sessionId-less failed entry has no ACK path (see FailedChatTurn's
    // doc comment), so before this fix it lingered until CHAT_COMPLETED_TURNS_MAX
    // eviction. Any client polling this project that is NOT the one that sent the doomed
    // message -- e.g. a viewer with no unresolved send of its own -- would see 'failed'
    // forever, fail every matchesTrackedSend/detached check in
    // chat/useTurnStatusRecovery.ts's checkTurnStatus, and fall through to an
    // unconditional 1-second re-poll with no
    // bound. Once the entry ages past FAILED_TURN_SESSIONLESS_TTL_MS, GET must stop
    // surfacing it so such a poller can settle back to 'idle'.
    let currentMs = 0;
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (): Promise<ChatTurnResult> => {
        throw new ChatAgentError('agent-timeout');
      }),
    });
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({
      agent: streamingAgent,
      cache,
      store: createChatSessionStore(),
      now: () => new Date(currentMs),
    });

    const send = await app.request('/api/chat/message/stream', withLocalHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', message: 'doomed new thread' }),
    }), LOCAL_ENV);
    expect(send.status).toBe(200);
    await send.text();

    // Past the TTL (FAILED_TURN_SESSIONLESS_TTL_MS = 60_000): no other entry is queued,
    // so GET must fall through to idle instead of surfacing the stale entry forever.
    currentMs += 60_001;
    const status = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await status.json()).toEqual({ state: 'idle' });
  });

  it('does not prune a session-scoped failed turn past the sessionId-less TTL (bdboard-kg0m)', async () => {
    // The TTL only targets sessionId-less entries, which have no ACK path. A
    // session-scoped entry is always ACK-able (DELETE /api/chat/turn-status), so it must
    // keep surfacing indefinitely regardless of age -- pruning it by time as well would
    // silently drop a legitimate failure a client hasn't gotten around to acking yet.
    let currentMs = 0;
    const sessionId = '550e8400-e29b-41d4-a716-446655440095';
    const streamingAgent = createFakeAgent({
      descriptor: { ...createFakeAgent().descriptor, supportsStreaming: true },
      sendMessageStream: vi.fn(async (): Promise<ChatTurnResult> => {
        throw new ChatAgentError('agent-timeout');
      }),
    });
    const store = createChatSessionStore();
    store.remember('p', sessionId, 'test-agent');
    const cache = createFakeBoardCache([cachedProject(project('p', '/tmp/p'))]);
    const app = createApp({
      agent: streamingAgent,
      cache,
      store,
      now: () => new Date(currentMs),
    });

    const send = await app.request('/api/chat/message/stream', withLocalHost({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', sessionId, message: 'doomed existing thread' }),
    }), LOCAL_ENV);
    expect(send.status).toBe(200);
    await send.text();

    // Well past the sessionId-less TTL (FAILED_TURN_SESSIONLESS_TTL_MS = 60_000): a
    // session-scoped entry must still be returned, unpruned.
    currentMs += 10 * 60_000;
    const status = await app.request('/api/chat/turn-status?projectId=p', withLocalHost({}), LOCAL_ENV);
    expect(await status.json()).toEqual({
      state: 'failed',
      code: 'agent-timeout',
      agentId: 'test-agent',
      sessionId,
      failedAt: new Date(0).toISOString(),
    });
  });

  describe('SSE keepalive ping', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.resetAllMocks();
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

