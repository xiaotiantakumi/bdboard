import { Hono, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { ChatSessionStore } from '../../application/chat/chat-session-store.js';
import {
  adoptChatSession,
  listDiscoveredChatSessions,
} from '../../application/chat/discover-chat-sessions.js';
import {
  finalizeChatTurnSuccess,
  sendChatMessage,
  type SendChatMessageResult,
} from '../../application/chat/send-chat-message.js';
import { resolveChatStreamTurn } from '../../application/chat/send-chat-message-stream.js';
import { listChatThreads } from '../../application/chat/list-chat-threads.js';
import { deleteChatThread } from '../../application/chat/delete-chat-thread.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { ChatMessageRepository } from '../../application/ports/chat-message-repository.js';
import type { ChatSessionDiscoveryPort } from '../../application/ports/chat-session-discovery.js';
import type { ChatAgentRegistry } from '../../application/chat/chat-agent-registry.js';
import { ChatAgentAbortedError, ChatAgentError, type ChatAgentPort, type ChatAgentAvailability } from '../../application/ports/chat-agent.js';
import { isValidChatSessionId } from '../../domain/chat.js';
import {
  createChatRateLimitMiddleware,
  createChatRateLimiter,
  DEFAULT_CHAT_RATE_LIMIT_WEIGHT,
  rateLimitedResponse,
  type ChatRateLimitExemptPattern,
} from './chat-rate-limit.js';
import {
  type ChatAgentDto,
  type DiscoveredChatSessionDto,
  toChatAgentDto,
  toSessionTailMessageDto,
} from './dto.js';
import { isLocalControlRequest } from './local-request.js';
import {
  createPrivilegedApiGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';
import {
  CHAT_IMAGE_MAX_COUNT,
  CHAT_MESSAGE_BODY_MAX_BYTES,
  decodeChatImages,
} from './chat-image-validation.js';

export const CHAT_CSRF_DENIED = 'cross-site chat request blocked';
export const CHAT_NOT_AUTHORIZED =
  'chat requires local access or an authorized tunnel session';
/** bdboard-3tw.104.3 レビュー N2: MF1 のローカル限定ガードが返す 403 本文を定数化してテストで固定する。 */
export const CHAT_SESSION_DISCOVERY_LOCAL_ONLY = 'chat session discovery is local-only';
export const DEFAULT_CHAT_AVAILABILITY_CACHE_MS = 60_000;

export interface ChatRoutesDeps {
  readonly cache: BoardCache;
  readonly agents: ChatAgentRegistry;
  readonly store: ChatSessionStore;
  readonly sessionDiscovery?: ChatSessionDiscoveryPort;
  readonly messages: ChatMessageRepository;
  /**
   * トンネル経由でチャットを開けるかの材料(bdboard-cu4)。渡さない場合は
   * 書き込みガードと同じく fail-closed = localhost 限定にフォールバックする。
   */
  readonly writeAccess?: WriteGuardDeps;
  /** テスト用に時計を差し替えるため。既定は実時計。 */
  readonly now?: () => Date;
  readonly rateLimit?: {
    readonly perMinute?: number;
    readonly perDay?: number;
    readonly defaultWeight?: number;
  };
  /** availability のサーバー側キャッシュ TTL(ms)。既定 60_000。 */
  readonly availabilityCacheMs?: number;
}

const messageBodySchema = z.object({
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

// bdboard-3tw.104.3 レビュー n9 → S1 で一般化: adopt は子プロセスを一切起こさない
// (ストアへの登録のみ)ので、トンネル経由でもレート制限のコスト計上から除外する。動的
// セグメント(:projectId/:sessionId)を挟むため exemptPaths(完全一致 Set)では表現できず、
// 104.12 で着地した exemptGetPathPatterns(GET専用)をメソッド非依存に一般化した
// exemptPathPatterns(chat-rate-limit.ts)に POST として乗せる。
const ADOPT_DISCOVERED_SESSION_PATH_PATTERN =
  /^\/api\/chat\/projects\/[^/]+\/discovered-sessions\/[^/]+\/adopt$/;

// 104.12 で着地した、子プロセスを起こさない GET(SQLite/インメモリ読み取りのみ)の免除。
const CHAT_SESSION_MESSAGES_PATH_PATTERN = /^\/api\/chat\/sessions\/[^/]+\/messages$/;
const CHAT_THREADS_PATH_PATTERN = /^\/api\/chat\/threads$/;
const CHAT_TURN_STATUS_PATH_PATTERN = /^\/api\/chat\/turn-status$/;

/**
 * 1プロジェクトが抱える未回収完了の上限 (bdboard-3tw.156)。ACK しないクライアント
 * に備えた歯止めで、通常運用で複数溜まるのは「返信を待たずに別スレッドへ移った」
 * 分だけなので、この数に届くことは想定していない。
 */
const CHAT_COMPLETED_TURNS_MAX = 20;

interface CompletedChatTurn {
  readonly sessionId: string;
  readonly agentId: string;
  readonly completedAt: string;
}

interface QueuedSseMessage {
  readonly event: string;
  readonly data: string;
}

/**
 * bdboard-l1t.9 Opus レビュー N2: streaming の `done` イベントの data と bulk の
 * 200 ボディを、同じ関数で組み立てて形を強制的に一致させる(`ok` フィールドを含む
 * finalizeChatTurnSuccess の戻り値をそのまま JSON.stringify すると、bulk 側には
 * 無い `ok: true` が streaming 側にだけ混ざってしまう)。
 */
function toChatMessageResponseBody(
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

const CHAT_RATE_LIMIT_EXEMPT_PATH_PATTERNS: readonly ChatRateLimitExemptPattern[] = [
  { method: 'GET', pattern: CHAT_SESSION_MESSAGES_PATH_PATTERN },
  { method: 'GET', pattern: CHAT_THREADS_PATH_PATTERN },
  { method: 'GET', pattern: CHAT_TURN_STATUS_PATH_PATTERN },
  { method: 'DELETE', pattern: CHAT_TURN_STATUS_PATH_PATTERN },
  { method: 'POST', pattern: ADOPT_DISCOVERED_SESSION_PATH_PATTERN },
];

export function createChatRoutes(deps: ChatRoutesDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());
  const availabilityCacheMs =
    deps.availabilityCacheMs ?? DEFAULT_CHAT_AVAILABILITY_CACHE_MS;
  const limiter = createChatRateLimiter({
    now,
    perMinute: deps.rateLimit?.perMinute,
    perDay: deps.rateLimit?.perDay,
  });
  const defaultWeight = deps.rateLimit?.defaultWeight ?? DEFAULT_CHAT_RATE_LIMIT_WEIGHT;
  // 未回収の完了ターン。クライアントが ACK するまでサーバーが持つ。
  //
  // プロジェクト1枠ではなく **キュー** なのは、1枠だと「スレッドAの返信を待たずに
  // 別スレッドへ移り、そちらで送信した」時点でAの完了が黙って上書きされ、
  // Aの返信が永久に回収されなくなるため (bdboard-3tw.155 で実測)。同じ
  // sessionId の完了は最新で置き換え、古いものから順に配る。
  //
  // ACK しないクライアントに備えて上限を切る。溢れたら古い方から捨てる —
  // 取りこぼしは「その1スレッドが再取得されるまで古いまま」で済むが、
  // 無制限に積むとプロセスが太り続ける。
  const completedTurns = new Map<string, readonly CompletedChatTurn[]>();
  const recordCompletedTurn = (projectId: string, entry: CompletedChatTurn): void => {
    const queued = completedTurns.get(projectId) ?? [];
    const next = [...queued.filter((item) => item.sessionId !== entry.sessionId), entry];
    completedTurns.set(projectId, next.slice(-CHAT_COMPLETED_TURNS_MAX));
  };
  const ackCompletedTurn = (projectId: string, sessionId: string): void => {
    const queued = completedTurns.get(projectId);
    if (queued === undefined) return;
    const next = queued.filter((item) => item.sessionId !== sessionId);
    if (next.length === 0) {
      completedTurns.delete(projectId);
      return;
    }
    completedTurns.set(projectId, next);
  };
  const rateLimit = createChatRateLimitMiddleware(limiter, {
    // /api/chat/agents は免除しない: 1 リクエストで N 個の --version 子プロセスを
    // 起こしうる増幅があるため、ミドルウェアの per-request カウントで抑える。
    exemptPaths: ['/api/chat/availability'],
    // 以下は claude CLI などの子プロセスを起動せず、SQLite/インメモリを読むだけ(GET 2件)
    // または子プロセスを一切起こさない(adopt の POST 1件)なので、トンネル経由でも
    // レート課金から除外する。ただし認証ガード(chatGuard / discoverySessionsLocalOnlyGuard)
    // は引き続き通す — discovered-sessions/adopt は結局ローカル限定になるが(MF1)、
    // ガードで弾かれる前に無駄にレート予算を消費させないための二重の防御。
    exemptPathPatterns: CHAT_RATE_LIMIT_EXEMPT_PATH_PATTERNS,
    defaultWeight,
    resolveWeight: ({ agentId, model }) => {
      const agent = agentId !== undefined ? deps.agents.get(agentId) : deps.agents.defaultAgent();
      if (agent === undefined) {
        return defaultWeight;
      }
      const modelId = model ?? agent.descriptor.model;
      if (modelId === undefined) {
        return defaultWeight;
      }
      return agent.descriptor.models?.find((entry) => entry.id === modelId)?.weight ?? defaultWeight;
    },
  });

  // bdboard-cu4: ローカル限定から「ローカル直 || (強パスワードのトンネル &&
  // QR 由来のセッション Cookie) && same-origin」へ緩める。条件はここで再実装せず、
  // 9rz が集約した evaluateWriteAccess をそのまま使う(チャットだけ緩い/厳しいが
  // 起きないようにするため)。メソッド判定を持たない版を使うのは、
  // GET /api/chat/availability も claude CLI を起動する副作用付きの呼び出しで、
  // 素の write-guard では素通りしてしまうから。
  //
  // Hono は両方のパターンが要る: '/api/chat' 単体はサブパスに、'/api/chat/*' 単体は
  // コレクションパス自身にマッチしない。前方一致なので、この下に後から足された
  // チャットのエンドポイント (例: GET /api/chat/agents) もガード掛け忘れで
  // 無防備に出荷されない。
  const chatGuard = createPrivilegedApiGuardMiddleware(deps.writeAccess ?? {}, {
    csrf: CHAT_CSRF_DENIED,
    notAuthorized: CHAT_NOT_AUTHORIZED,
  });

  app.use('/api/chat', chatGuard);
  app.use('/api/chat/*', chatGuard);
  // rate-limit middleware also parses POST JSON to resolve model weight. Put the body
  // guard first so an oversized base64 payload is rejected before either JSON parse.
  const chatMessageBodyLimit = bodyLimit({
    maxSize: CHAT_MESSAGE_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  });
  app.use('/api/chat/message', chatMessageBodyLimit);
  app.use('/api/chat/message/stream', chatMessageBodyLimit);
  app.use('/api/chat', rateLimit);
  app.use('/api/chat/*', rateLimit);

  // bdboard-3tw.104.3 レビュー MF1: セッション発見(discovered-sessions)と adopt は、
  // 通常の chatGuard (トンネル書き込みが許可されていれば通す) よりも厳しく、常にローカル限定
  // にする。
  //
  // 脅威モデルの正確な範囲 (S6 — human 票 104.15 の判断材料になるため厳密に書く):
  // 個々のトランスクリプトの「中身の閲覧」自体は、本エンドポイント無しでも既に
  // トンネル経由で可能 — `GET /api/sessions/:id/tail` は sessionId さえ分かれば書き込み
  // ガード(bdboard-9rz、メソッド判定のみ)を素通りする。したがって MF1 がここで新たに
  // 閉じているのは中身の閲覧そのものではなく、
  //   (1) 列挙: discovered-sessions が「このプロジェクトの既知の端末セッション ID を
  //       総当りせずに一覧できる」機能を新設したこと(sessionId を知らなくても発見できる)。
  //   (2) --resume 紐付け: adopt が発見したセッションを bdboard の chat-session-store に
  //       登録し、以後 POST /api/chat/message からそのセッションIDで `claude --resume`
  //       を実行できる状態にすること(単なる閲覧から、会話を継続実行できる状態への昇格)。
  // トンネル利用者が自分で作っていない端末セッションを新たに発見・resume 継続できて
  // しまう部分を当面ローカル限定にする、という狭い意図。外部開放はユーザー裁定チケット
  // (bdboard-3tw.104.15)参照。
  //
  // '/discovered-sessions' 単体は '/discovered-sessions/*' にマッチしない(前方一致は
  // サブパスのみ)ので、GET(一覧)と POST(adopt)の両方を掛け忘れなく覆うため両方登録する。
  const discoverySessionsLocalOnlyGuard: MiddlewareHandler = async (c, next) => {
    if (!isLocalControlRequest(c)) {
      return c.json({ error: CHAT_SESSION_DISCOVERY_LOCAL_ONLY }, 403);
    }
    await next();
  };
  app.use('/api/chat/projects/:projectId/discovered-sessions', discoverySessionsLocalOnlyGuard);
  app.use('/api/chat/projects/:projectId/discovered-sessions/*', discoverySessionsLocalOnlyGuard);

  // エージェントごとにキャッシュする。GET /api/chat/agents は 1 リクエストで
  // エージェント数ぶんの可用性プローブ (CLI の子プロセス) を起こしうるので、
  // キャッシュが増幅の唯一の歯止め。
  const availabilityCache = new Map<
    string,
    { readonly availability: ChatAgentAvailability; readonly at: number }
  >();

  const cachedAvailability = (
    agentId: string,
    currentMs: number,
  ): ChatAgentAvailability | undefined => {
    const entry = availabilityCache.get(agentId);
    if (entry !== undefined && currentMs - entry.at < availabilityCacheMs) {
      return entry.availability;
    }
    return undefined;
  };

  const probeAvailability = async (
    agent: ChatAgentPort,
    currentMs: number,
  ): Promise<ChatAgentAvailability> => {
    let availability: ChatAgentAvailability;
    try {
      availability = await agent.checkAvailability();
    } catch {
      // ポートが例外を投げたのは「判定できなかった」であって、未認証の証拠ではない。
      availability = 'unknown';
    }
    availabilityCache.set(agent.descriptor.id, { availability, at: currentMs });
    return availability;
  };

  app.get('/api/chat/availability', async (c) => {
    const currentMs = now().getTime();
    const defaultAgent = deps.agents.defaultAgent();
    if (defaultAgent === undefined) {
      return c.json({ availability: 'unavailable' });
    }

    const agentId = defaultAgent.descriptor.id;
    const cached = cachedAvailability(agentId, currentMs);
    if (cached !== undefined) {
      return c.json({ availability: cached });
    }

    if (!isLocalControlRequest(c)) {
      const decision = limiter.consume();
      if (decision.kind === 'deny') {
        return rateLimitedResponse(c, decision);
      }
    }

    const availability = await probeAvailability(defaultAgent, currentMs);
    return c.json({ availability });
  });

  app.get('/api/chat/agents', async (c) => {
    const currentMs = now().getTime();
    const agents: ChatAgentDto[] = [];

    // 逐次に回す (Promise.all にしない): 1 リクエストで同時に N 個の子プロセスを
    // 起こさないため。キャッシュにより 1 エージェントあたり最大 1 回のプローブ。
    for (const agent of deps.agents.list()) {
      const cached = cachedAvailability(agent.descriptor.id, currentMs);
      const availability =
        cached ?? (await probeAvailability(agent, currentMs));
      agents.push(toChatAgentDto(agent.descriptor, availability));
    }

    return c.json(agents);
  });

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
    const completed = completedTurns.get(parsed.data.projectId)?.[0];
    if (completed !== undefined) {
      return c.json({ state: 'completed' as const, ...completed });
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
    ackCompletedTurn(parsed.data.projectId, parsed.data.sessionId);
    return c.body(null, 204);
  });

  app.patch('/api/chat/sessions/:sessionId/thread', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!isValidChatSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const parsed = threadPatchBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }

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

  app.post('/api/chat/message', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const parsed = messageBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }
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
      recordCompletedTurn(parsed.data.projectId, {
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

  app.post('/api/chat/message/stream', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }
    const parsed = messageBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid request body' }, 400);
    const images = decodeChatImages(parsed.data.images);
    if (images === undefined && parsed.data.images !== undefined) {
      return c.json({ error: 'invalid request body' }, 400);
    }
    const sendInput = {
      projectId: parsed.data.projectId,
      message: parsed.data.message,
      ...(parsed.data.sessionId !== undefined ? { sessionId: parsed.data.sessionId } : {}),
      ...(parsed.data.agentId !== undefined ? { agentId: parsed.data.agentId } : {}),
      ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
      ...(images !== undefined && images.length > 0 ? { images } : {}),
    };
    const resolved = await resolveChatStreamTurn(deps, sendInput);
    if (!resolved.ok) {
      switch (resolved.failure.kind) {
        case 'project-not-found': return c.json({ error: 'project not found' }, 404);
        case 'invalid-message': return c.json({ error: 'invalid message', detail: resolved.failure.detail }, 400);
        case 'unknown-session': return c.json({ error: 'unknown chat session' }, 400);
        case 'unknown-agent': return c.json({ error: 'unknown chat agent', detail: resolved.failure.detail }, 400);
        case 'unknown-model': return c.json({ error: 'unknown chat model', detail: resolved.failure.detail }, 400);
        case 'agent-mismatch': return c.json({ error: 'chat agent mismatch', detail: resolved.failure.detail }, 400);
        case 'agent-unavailable': return c.json({ error: 'chat agent unavailable', detail: resolved.failure.detail }, 503);
        case 'busy': return c.json({ error: 'chat is busy for this project' }, 409);
        case 'streaming-not-supported': return c.json({ error: 'chat agent does not support streaming' }, 400);
        case 'image-not-supported': return c.json({ error: 'chat agent does not support image attachments' }, 400);
        case 'agent-error': return c.json({ error: 'chat failed', code: resolved.failure.code, detail: resolved.failure.detail }, 502);
      }
    }

    // 未回収の完了はここで消さない。以前は「新しいターンの完了が前のメタデータを
    // 置き換える」前提で1枠を消していたが、それだと別スレッドで送信しただけで
    // 先行スレッドの未回収返信が消え、二度と回収されなくなる (bdboard-3tw.155)。
    // 完了はキューに積み、クライアントの ACK でだけ落とす。

    // bdboard-l1t.9 Opus レビュー N6: リバースプロキシ(nginx等)が SSE をバッファ
    // リングして届かない/遅延することがあるための明示無効化。トンネル実機での
    // 実際のバースト到達確認は別チケット(議長側で起票)。
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const queue: QueuedSseMessage[] = [];
      let wake: (() => void) | undefined;
      let clientGone = false;
      let cleanedUp = false;
      let finished = false;
      const signal = c.req.raw.signal;
      const waitForQueue = (): Promise<void> => new Promise((resolve) => {
        wake = resolve;
        if (queue.length > 0 || clientGone || finished) {
          wake = undefined;
          resolve();
        }
      });
      const wakeUp = (): void => {
        const resume = wake;
        wake = undefined;
        resume?.();
      };
      const enqueue = (message: QueuedSseMessage): void => {
        queue.push(message);
        wakeUp();
      };
      const cleanup = (): void => {
        // bdboard-7st added the browser-side fetch abort, but the old server cleanup
        // forwarded that abort to the CLI process and killed the actual AI turn.
        // A disconnect now stops SSE delivery only; runTurn deliberately receives no
        // request signal and continues through finalizeChatTurnSuccess for recovery.
        // onAbort() and the request signal can both arrive, so cleanup stays idempotent.
        if (cleanedUp) return;
        cleanedUp = true;
        clientGone = true;
        wakeUp();
        signal.removeEventListener('abort', cleanup);
      };
      stream.onAbort(cleanup);
      if (signal.aborted) {
        cleanup();
      } else {
        signal.addEventListener('abort', cleanup);
      }

      const runTurn = async (): Promise<void> => {
        try {
          const turnResult = await resolved.handle.agent.sendMessageStream!(
            resolved.handle.turnRequest,
            (delta) => {
              if (!clientGone) {
                enqueue({ event: 'delta', data: JSON.stringify({ text: delta.text }) });
              }
            },
          );
          // finalize(store.remember + messages.append) is the durable boundary and must
          // run even after clientGone. Only SSE delivery is conditional on the subscriber;
          // the detached turn itself remains server-owned until this point.
          const success = finalizeChatTurnSuccess(deps, sendInput, turnResult);
          recordCompletedTurn(parsed.data.projectId, {
            sessionId: success.sessionId,
            agentId: success.agentId,
            completedAt: now().toISOString(),
          });
          if (!clientGone) {
            enqueue({ event: 'done', data: JSON.stringify(toChatMessageResponseBody(success)) });
          }
        } catch (err) {
          if (err instanceof ChatAgentAbortedError) {
            console.debug('chat stream aborted');
          } else if (err instanceof ChatAgentError) {
            if (!clientGone) {
              enqueue({ event: 'error', data: JSON.stringify({ error: 'chat failed', code: err.code, detail: err.detail }) });
            }
          } else {
            throw err;
          }
        }
      };
      const turnPromise = runTurn().finally(() => {
        finished = true;
        wakeUp();
      });

      try {
        while (!clientGone && !stream.aborted && !stream.closed) {
          while (queue.length > 0) {
            const message = queue.shift();
            if (message !== undefined) await stream.writeSSE(message);
          }
          if (clientGone || stream.aborted || stream.closed || finished) break;
          await waitForQueue();
        }
        await turnPromise;
      } finally {
        cleanup();
        resolved.handle.release();
      }
    });
  });

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

  const adoptBodySchema = z.object({ agentId: z.string().min(1).max(200).optional() });
  app.post('/api/chat/projects/:projectId/discovered-sessions/:sessionId/adopt', async (c) => {
    if (deps.sessionDiscovery === undefined) {
      return c.json({ error: 'session discovery not available' }, 501);
    }
    const projectId = c.req.param('projectId');
    if (projectId.length === 0 || projectId.length > 200) {
      return c.json({ error: 'invalid project id' }, 400);
    }

    let body: unknown = {};
    const rawBody = await c.req.text();
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return c.json({ error: 'invalid request body' }, 400);
      }
    }
    const parsed = adoptBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid request body' }, 400);

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
