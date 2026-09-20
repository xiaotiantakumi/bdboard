// bdboard-sso1.17: chat-routes.ts (1015行) の分割で、スレッド/セッション系の
// GET /api/chat/sessions/:sessionId/messages・GET /api/chat/threads・GET,DELETE
// /api/chat/turn-status・PATCH /api/chat/sessions/:sessionId/thread・DELETE
// /api/chat/sessions/:sessionId をここへ切り出した (move only, 挙動変更ゼロ)。
// turn-status の completed/failed キューは POST /api/chat/message(/stream) 側
// (chat-message-routes.ts / chat-message-stream-routes.ts) とも読み書きを共有する
// ため、所有者を chat-turn-tracker.ts の1インスタンスに保ったまま受け取る
// (状態を複製しない)。

import { Hono } from 'hono';
import { z } from 'zod';
import type { ChatSessionStore } from '../../application/chat/chat-session-store.js';
import { listChatThreads } from '../../application/chat/list-chat-threads.js';
import { deleteChatThread } from '../../application/chat/delete-chat-thread.js';
import type { ChatMessageRepository } from '../../application/ports/chat-message-repository.js';
import { isValidChatSessionId } from '../../domain/chat.js';
import type { ChatTurnTracker } from './chat-turn-tracker.js';
import { parseJsonBody } from './request-body.js';

export interface ChatThreadRoutesDeps {
  readonly store: ChatSessionStore;
  readonly messages: ChatMessageRepository;
}

const sessionMessagesQuerySchema = z.object({
  projectId: z.string().min(1).max(200),
});

const threadsQuerySchema = sessionMessagesQuerySchema;

const threadPatchBodySchema = z
  .object({
    projectId: z.string().min(1).max(200),
    title: z
      .union([
        z.null(),
        z.string().transform((value) => value.trim()).pipe(z.string().min(1).max(200)),
      ])
      .optional(),
    pinned: z.boolean().optional(),
  })
  .refine((body) => body.title !== undefined || body.pinned !== undefined, {
    message: 'invalid request body',
  });

export function createChatThreadRoutes(deps: ChatThreadRoutesDeps, turnTracker: ChatTurnTracker): Hono {
  const app = new Hono();

  app.get('/api/chat/sessions/:sessionId/messages', (c) => {
    const sessionId = c.req.param('sessionId');
    if (!isValidChatSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }

    const parsed = sessionMessagesQuerySchema.safeParse({
      projectId: c.req.query('projectId'),
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid query' }, 400);
    }

    const record = deps.store.lookup(parsed.data.projectId, sessionId);
    if (record === undefined) {
      return c.json({ error: 'unknown chat session' }, 404);
    }

    const rows = deps.messages.listBySession(sessionId);
    return c.json({
      sessionId,
      agentId: record.agentId,
      ...(record.model !== undefined ? { model: record.model } : {}),
      messages: rows.map((row) => ({
        role: row.role,
        content: row.content,
        createdAt: row.createdAt.toISOString(),
        ...(row.failedTools !== undefined && row.failedTools.length > 0
          ? { failedTools: row.failedTools }
          : {}),
        ...(row.agentWarnings !== undefined && row.agentWarnings.length > 0
          ? { agentWarnings: row.agentWarnings }
          : {}),
      })),
    });
  });

  app.get('/api/chat/threads', (c) => {
    const parsed = threadsQuerySchema.safeParse({ projectId: c.req.query('projectId') });
    if (!parsed.success) return c.json({ error: 'invalid query' }, 400);
    return c.json(
      listChatThreads(deps.store, deps.messages, parsed.data.projectId).map((thread) => ({
        sessionId: thread.sessionId,
        agentId: thread.agentId,
        title: thread.title,
        pinned: thread.pinned,
        updatedAt: thread.updatedAt.toISOString(),
      })),
    );
  });

  app.get('/api/chat/turn-status', (c) => {
    const parsed = threadsQuerySchema.safeParse({ projectId: c.req.query('projectId') });
    if (!parsed.success) return c.json({ error: 'invalid query' }, 400);
    if (deps.store.isBusy(parsed.data.projectId)) {
      const pending = deps.store.pendingTurn(parsed.data.projectId);
      if (pending !== undefined) {
        return c.json({
          state: 'processing' as const,
          message: pending.message,
          agentId: pending.agentId,
          ...(pending.sessionId !== undefined ? { sessionId: pending.sessionId } : {}),
        });
      }
      return c.json({ state: 'processing' as const });
    }
    // 古い方から配る。クライアントは1件回収して ACK したらもう一度聞きに来るので、
    // 溜まっていても順に掃ける。
    const completed = turnTracker.peekCompleted(parsed.data.projectId);
    if (completed !== undefined) {
      return c.json({ state: 'completed' as const, ...completed });
    }
    // bdboard-3tw.165: completed の次に failed を見る。同じプロジェクトの
    // ターンは isBusy の単一ロックで直列化されるので、1つのターンが completed と
    // failed の両方に載ることは無い (別ターンどうしがそれぞれ未回収のまま
    // 両方のキューに残ることはあり得るが、completed 優先で構わない)。
    const failed = turnTracker.peekFailed(parsed.data.projectId);
    if (failed !== undefined) {
      return c.json({
        state: 'failed' as const,
        code: failed.code,
        agentId: failed.agentId,
        failedAt: failed.failedAt,
        ...(failed.sessionId !== undefined ? { sessionId: failed.sessionId } : {}),
      });
    }
    return c.json({ state: 'idle' as const });
  });

  app.delete('/api/chat/turn-status', (c) => {
    const parsed = z.object({
      projectId: z.string().min(1).max(200),
      sessionId: z.string().refine(isValidChatSessionId),
    }).safeParse({
      projectId: c.req.query('projectId'),
      sessionId: c.req.query('sessionId'),
    });
    if (!parsed.success) return c.json({ error: 'invalid query' }, 400);
    turnTracker.ackCompleted(parsed.data.projectId, parsed.data.sessionId);
    turnTracker.ackFailed(parsed.data.projectId, parsed.data.sessionId);
    return c.body(null, 204);
  });

  app.patch('/api/chat/sessions/:sessionId/thread', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!isValidChatSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }

    const parsed = await parseJsonBody(c, threadPatchBodySchema);
    if (!parsed.ok) return parsed.response;

    const { projectId, title, pinned } = parsed.data;
    if (deps.store.lookup(projectId, sessionId) === undefined) {
      return c.json({ error: 'unknown chat session' }, 404);
    }

    if (title !== undefined) {
      deps.store.rename(projectId, sessionId, title);
    }
    if (pinned !== undefined) {
      deps.store.setPinned(projectId, sessionId, pinned);
    }

    const thread = listChatThreads(deps.store, deps.messages, projectId).find(
      (entry) => entry.sessionId === sessionId,
    );
    if (thread === undefined) {
      return c.json({ error: 'unknown chat session' }, 404);
    }

    return c.json({
      sessionId: thread.sessionId,
      agentId: thread.agentId,
      title: thread.title,
      pinned: thread.pinned,
      updatedAt: thread.updatedAt.toISOString(),
    });
  });

  app.delete('/api/chat/sessions/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId');
    if (!isValidChatSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    const parsed = sessionMessagesQuerySchema.safeParse({ projectId: c.req.query('projectId') });
    if (!parsed.success) return c.json({ error: 'invalid query' }, 400);
    if (!deleteChatThread(deps.store, deps.messages, parsed.data.projectId, sessionId)) {
      return c.json({ error: 'unknown chat session' }, 404);
    }
    return c.body(null, 204);
  });

  return app;
}
