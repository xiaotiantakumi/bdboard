// bdboard-sso1.17: chat-routes.ts (1015行) の分割で、POST /api/chat/message
// (bulk 送信) をここへ切り出した (move only, 挙動変更ゼロ)。messageBodySchema と
// toChatMessageResponseBody は POST /api/chat/message/stream
// (chat-message-stream-routes.ts) とも共有するため、ここからエクスポートして
// 両方から同じ定義を参照する (重複させない)。

import { Hono } from 'hono';
import { z } from 'zod';
import { sendChatMessage, type SendChatMessageResult } from '../../application/chat/send-chat-message.js';
import type { ChatSessionStore } from '../../application/chat/chat-session-store.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { ChatAgentRegistry } from '../../application/chat/chat-agent-registry.js';
import type { ChatMessageRepository } from '../../application/ports/chat-message-repository.js';
import { isValidChatSessionId } from '../../domain/chat.js';
import type { WriteGuardDeps } from './write-guard.js';
import {
  CHAT_IMAGE_MAX_COUNT,
  decodeChatImages,
} from './chat-image-validation.js';
import { parseJsonBody } from './request-body.js';
import type { ChatTurnTracker } from './chat-turn-tracker.js';

export interface ChatMessageRoutesDeps {
  readonly cache: BoardCache;
  readonly agents: ChatAgentRegistry;
  readonly store: ChatSessionStore;
  readonly messages: ChatMessageRepository;
  readonly writeAccess?: WriteGuardDeps;
}

export const messageBodySchema = z.object({
  projectId: z.string().min(1).max(200),
  // 画像だけのターンでは空文字を許可する。画像も無ければ application 層が従来どおり拒否する。
  message: z.string().max(4000),
  // UUID 固定にしない: セッションIDの形式は CLI アダプタごとに違う (claude は UUID だが
  // 他ツールはそうとは限らない)。不透明な識別子として安全性だけを domain 側で検証する。
  sessionId: z.string().refine(isValidChatSessionId).optional(),
  agentId: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(100).optional(),
  images: z.array(z.object({
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    data: z.string(),
  })).max(CHAT_IMAGE_MAX_COUNT).optional(),
});

/**
 * bdboard-l1t.9 Opus レビュー N2: streaming の `done` イベントの data と bulk の
 * 200 ボディを、同じ関数で組み立てて形を強制的に一致させる(`ok` フィールドを含む
 * finalizeChatTurnSuccess の戻り値をそのまま JSON.stringify すると、bulk 側には
 * 無い `ok: true` が streaming 側にだけ混ざってしまう)。
 */
export function toChatMessageResponseBody(
  success: Extract<SendChatMessageResult, { readonly ok: true }>,
): {
  readonly reply: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly model?: string;
  readonly failedTools?: readonly string[];
  readonly agentWarnings?: readonly string[];
} {
  return {
    reply: success.reply,
    sessionId: success.sessionId,
    agentId: success.agentId,
    ...(success.model !== undefined ? { model: success.model } : {}),
    ...(success.failedTools !== undefined ? { failedTools: success.failedTools } : {}),
    ...(success.agentWarnings !== undefined ? { agentWarnings: success.agentWarnings } : {}),
  };
}

export function createChatMessageRoutes(
  deps: ChatMessageRoutesDeps,
  params: { readonly now: () => Date; readonly turnTracker: ChatTurnTracker },
): Hono {
  const app = new Hono();
  const { now, turnTracker } = params;

  app.post('/api/chat/message', async (c) => {
    const parsed = await parseJsonBody(c, messageBodySchema);
    if (!parsed.ok) return parsed.response;
    const images = decodeChatImages(parsed.data.images);
    if (images === undefined && parsed.data.images !== undefined) {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const sendInput = {
      projectId: parsed.data.projectId,
      message: parsed.data.message,
      ...(parsed.data.sessionId !== undefined
        ? { sessionId: parsed.data.sessionId }
        : {}),
      ...(parsed.data.agentId !== undefined
        ? { agentId: parsed.data.agentId }
        : {}),
      ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
      ...(images !== undefined && images.length > 0 ? { images } : {}),
    };

    const result = await sendChatMessage(deps, sendInput);

    if (result.ok) {
      // Publish before writing the response. The client explicitly ACKs only after it
      // incorporated the reply, closing the finalize-vs-disconnect race for both bulk
      // and streaming transports.
      turnTracker.recordCompleted(parsed.data.projectId, {
        sessionId: result.sessionId,
        agentId: result.agentId,
        completedAt: now().toISOString(),
      });
      return c.json(toChatMessageResponseBody(result));
    }

    switch (result.failure.kind) {
      case 'project-not-found':
        return c.json({ error: 'project not found' }, 404);
      case 'invalid-message':
        return c.json(
          { error: 'invalid message', detail: result.failure.detail },
          400,
        );
      case 'unknown-session':
        return c.json({ error: 'unknown chat session' }, 400);
      case 'unknown-agent':
        return c.json(
          { error: 'unknown chat agent', detail: result.failure.detail },
          400,
        );
      case 'unknown-model':
        return c.json(
          { error: 'unknown chat model', detail: result.failure.detail },
          400,
        );
      case 'agent-mismatch':
        return c.json(
          { error: 'chat agent mismatch', detail: result.failure.detail },
          400,
        );
      case 'agent-unavailable':
        return c.json(
          { error: 'chat agent unavailable', detail: result.failure.detail },
          503,
        );
      case 'busy':
        return c.json({ error: 'chat is busy for this project' }, 409);
      case 'streaming-not-supported':
        // bdboard-l1t.9 Opus レビュー S3: この kind は resolveChatStreamTurn
        // (/api/chat/message/stream 側)専用で、bulk 経路の resolveChatTurnAgent
        // からは作られない。到達しないはずだが、switch を default 付きで
        // 網羅させて将来 SendChatMessageFailure に新しい kind が増えたときの
        // コンパイラ保証(下の default の never チェック)を保つための防御的分岐。
        // bdboard-l1t.9 delta 再レビュー nit: code には ChatFailureCode の
        // メンバーを使う必要がある('agent-error' はこの型に存在しない)。
        // ここは分類不能な防御的フォールバックなので、汎用の
        // 'agent-exit-nonzero' を割り当てる。
        return c.json(
          { error: 'chat failed', code: 'agent-exit-nonzero', detail: 'unexpected failure kind' },
          500,
        );
      case 'image-not-supported':
        return c.json({ error: 'chat agent does not support image attachments' }, 400);
      case 'agent-error':
        // detail は CHAT_FAILURE_MESSAGES 由来の定型文だけ。子プロセスの
        // 生出力をここに載せてはいけない (bdboard-pvl)。
        return c.json(
          {
            error: 'chat failed',
            code: result.failure.code,
            detail: result.failure.detail,
          },
          502,
        );
      default: {
        const exhaustive: never = result.failure;
        return exhaustive;
      }
    }
  });

  return app;
}
