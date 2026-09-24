import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_FAILURE_MESSAGES,
  ChatAgentError,
  type ChatTurnResult,
} from '../../application/ports/chat-agent.js';
import { createChatSessionStore } from '../../application/chat/chat-session-store.js';
import { createInMemoryChatMessageRepository } from '../../application/chat/in-memory-chat-message-repository.js';
import { createChatAgentRegistry } from '../../application/chat/chat-agent-registry.js';
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
// (2/3)。POST /api/chat/message (bulk 送信・再送・sessionId/agentId/model
// バリデーション・メッセージ永続化)を chat-message-routes.ts の対応先としてまとめた。
// テスト本体・期待値・モックの記述は元の chat-routes.test.ts から一字一句変更して
// いない。describe の入れ物のみ再構成した: 元 'chat sessionId validation and
// agentId' describe の一部 (sessionId/agentId/model バリデーション本体) を
// 新しい describe 'POST /api/chat/message sessionId/agentId/model validation
// (bdboard-l1t.2 step 2)' にまとめ、'stores messages when posting a chat
// message' の1件を新しい describe 'POST /api/chat/message persistence' に
// まとめた。'detached bulk chat turn recovery' と 'createChatRoutes behavior'
// はそのまま移動。
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

// bdboard-m92p: this guard used to read chat-routes.ts, which is where the
// sessionId zod schema lived before bdboard-sso1.17 (PR #554) split
// chat-routes.ts into per-resource route files. chat-routes.ts is now a
// composition layer only (it re-exports/wires the split route modules and
// defines no schema), so the old check silently passed regardless of what
// the real schema said. `git grep -n "z\.string()\.refine(isValidChatSessionId"
// src/` shows the sessionId schema is actually defined in two places now:
// chat-message-routes.ts (POST /api/chat/message body) and
// chat-thread-routes.ts (thread routes) -- both refine() with the domain's
// isValidChatSessionId() (src/domain/chat.ts) rather than zod's own
// `.uuid()`, on purpose: other CLI agents' session ids are not UUIDs (see
// isValidChatSessionId's doc comment), so accidentally reintroducing
// `.uuid()` in either schema would reject valid non-Claude session ids.
// chat-message-stream-routes.ts reuses chat-message-routes.ts's
// messageBodySchema rather than defining its own, and
// chat-discovery-routes.ts validates sessionId via isValidChatSessionId
// directly (no zod), so neither needs its own entry here. Point the check
// at both files that actually define a sessionId zod schema.
const SESSION_ID_SCHEMA_SOURCES: ReadonlyMap<string, string> = new Map(
  ['chat-message-routes.ts', 'chat-thread-routes.ts'].map((name) => [
    name,
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), name),
      'utf8',
    ),
  ]),
);

describe('POST /api/chat/message sessionId/agentId/model validation (bdboard-l1t.2 step 2)', () => {
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

  it('does not use .uuid() in the sessionId schemas (chat-message-routes.ts, chat-thread-routes.ts)', () => {
    // Guard against this assertion silently passing over zero files if the
    // schema source map above is ever emptied by mistake.
    expect(SESSION_ID_SCHEMA_SOURCES.size).toBeGreaterThan(0);

    // Pin each file to actually still define the sessionId schema via
    // refine(isValidChatSessionId), not just happen to be free of the
    // literal substring '.uuid('. Without this, a future move of the
    // schema out of these two files (while they both keep existing) would
    // make the check below pass vacuously again -- the exact failure mode
    // this ticket (bdboard-m92p) exists to fix.
    for (const [name, source] of SESSION_ID_SCHEMA_SOURCES) {
      expect(
        source,
        `${name} no longer defines the sessionId schema via refine(isValidChatSessionId); update this guard to point at wherever it moved`,
      ).toContain('refine(isValidChatSessionId');
    }

    const violations = [...SESSION_ID_SCHEMA_SOURCES.entries()]
      .filter(([, source]) => source.includes('.uuid('))
      .map(([name]) => name);

    expect(
      violations,
      `sessionId schema must not use .uuid() (it must accept the non-UUID session id formats other CLI agents use, e.g. sess_...). Violations: ${violations.join(', ')}`,
    ).toEqual([]);
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
});

describe('POST /api/chat/message persistence', () => {
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
});
