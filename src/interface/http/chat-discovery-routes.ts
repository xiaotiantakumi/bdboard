// bdboard-sso1.17: chat-routes.ts (1015行) の分割で、既知の端末セッションを
// bdboard へ引き込む(添付する) GET
// /api/chat/projects/:projectId/discovered-sessions と POST
// .../discovered-sessions/:sessionId/adopt をここへ切り出した (move only,
// 挙動変更ゼロ)。discoverySessionsLocalOnlyGuard の app.use() 登録はミドルウェア
// 適用順を保つため composition 層 (chat-routes.ts) に残したままなので、ここは
// ハンドラ2本のみ。

import { Hono } from 'hono';
import { z } from 'zod';
import type { ChatSessionStore } from '../../application/chat/chat-session-store.js';
import {
  adoptChatSession,
  listDiscoveredChatSessions,
} from '../../application/chat/discover-chat-sessions.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { ChatAgentRegistry } from '../../application/chat/chat-agent-registry.js';
import type { ChatSessionDiscoveryPort } from '../../application/ports/chat-session-discovery.js';
import { type DiscoveredChatSessionDto, toSessionTailMessageDto } from './dto.js';
import { parseJsonBody } from './request-body.js';

export interface ChatDiscoveryRoutesDeps {
  readonly cache: BoardCache;
  readonly agents: ChatAgentRegistry;
  readonly store: ChatSessionStore;
  readonly sessionDiscovery?: ChatSessionDiscoveryPort;
}

const adoptBodySchema = z.object({ agentId: z.string().min(1).max(200).optional() });

export function createChatDiscoveryRoutes(deps: ChatDiscoveryRoutesDeps): Hono {
  const app = new Hono();

  app.get('/api/chat/projects/:projectId/discovered-sessions', async (c) => {
    if (deps.sessionDiscovery === undefined) {
      return c.json({ error: 'session discovery not available' }, 501);
    }
    const projectId = c.req.param('projectId');
    if (projectId.length === 0 || projectId.length > 200) {
      return c.json({ error: 'invalid project id' }, 400);
    }

    const result = await listDiscoveredChatSessions(
      { cache: deps.cache, discovery: deps.sessionDiscovery, store: deps.store },
      projectId,
    );
    if (!result.ok) return c.json({ error: 'project not found' }, 404);

    const sessions: DiscoveredChatSessionDto[] = result.sessions.map((session) => ({
      sessionId: session.sessionId,
      lastActivityAt: session.lastActivityAt.toISOString(),
      alreadyAdopted: session.alreadyAdopted,
      ...(session.firstMessagePreview !== undefined
        ? { firstMessagePreview: session.firstMessagePreview }
        : {}),
      ...(session.lastMessagePreview !== undefined
        ? { lastMessagePreview: session.lastMessagePreview }
        : {}),
    }));
    return c.json({ sessions });
  });

  app.post('/api/chat/projects/:projectId/discovered-sessions/:sessionId/adopt', async (c) => {
    if (deps.sessionDiscovery === undefined) {
      return c.json({ error: 'session discovery not available' }, 501);
    }
    const projectId = c.req.param('projectId');
    if (projectId.length === 0 || projectId.length > 200) {
      return c.json({ error: 'invalid project id' }, 400);
    }

    const parsed = await parseJsonBody(c, adoptBodySchema, { optionalBody: true });
    if (!parsed.ok) return parsed.response;

    const result = await adoptChatSession(
      { cache: deps.cache, discovery: deps.sessionDiscovery, store: deps.store, agents: deps.agents },
      {
        projectId,
        sessionId: c.req.param('sessionId'),
        ...(parsed.data.agentId !== undefined ? { agentId: parsed.data.agentId } : {}),
      },
    );
    if (result.ok) {
      // bdboard-3tw.104.3 レビュー M1: 履歴シードは adopt レスポンスに同梱して返す。
      // discovery が local-only ガード配下で既に読んだトランスクリプトそのものが元なので、
      // 別途 `/api/sessions/:id/tail`(ライブセッションインデックス由来、終了済みセッションは
      // ほぼ載っていない)を叩き直す必要がない。
      return c.json({
        sessionId: result.sessionId,
        agentId: result.agentId,
        seedMessages: result.seedMessages.map(toSessionTailMessageDto),
      });
    }

    switch (result.failure.kind) {
      case 'project-not-found': return c.json({ error: 'project not found' }, 404);
      case 'invalid-session-id': return c.json({ error: 'invalid session id' }, 400);
      case 'unknown-agent': return c.json({ error: 'unknown chat agent', detail: result.failure.detail }, 400);
      case 'unknown-session': return c.json({ error: 'unknown chat session' }, 404);
    }
  });

  return app;
}
