import { describe, expect, it, vi } from 'vitest';
import { createChatSessionStore } from '../../application/chat/chat-session-store.js';
import { createInMemoryChatMessageRepository } from '../../application/chat/in-memory-chat-message-repository.js';
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
// ルートモジュール分割 (bdboard-sso1.17) に追随させて move-only 分割した一部
// (2/3)。GET /api/chat/sessions/:id/messages・GET /api/chat/threads・PATCH
// /api/chat/sessions/:id/thread・DELETE /api/chat/sessions/:id
// (chat-thread-routes.ts の対応先) をまとめた。テスト本体・期待値・モックの記述は
// 元の chat-routes.test.ts から一字一句変更していない。元 'chat sessionId
// validation and agentId' describe のうち、この一部のみを新しい describe
// 'chat thread/session routes (messages, threads, thread patch, session
// delete)' にまとめた (describe の入れ物のみ再構成)。
describe('chat thread/session routes (messages, threads, thread patch, session delete)', () => {
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
});
