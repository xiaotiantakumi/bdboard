import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ChatSessionStore } from '../../application/chat/chat-session-store.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { ChatMessageRepository } from '../../application/ports/chat-message-repository.js';
import type { ChatAgentRegistry } from '../../application/chat/chat-agent-registry.js';
import {
  createChatRateLimitMiddleware,
  createChatRateLimiter,
  DEFAULT_CHAT_RATE_LIMIT_WEIGHT,
  type ChatRateLimitExemptPattern,
} from './chat-rate-limit.js';
import {
  createPrivilegedApiGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';
import { CHAT_MESSAGE_BODY_MAX_BYTES } from './chat-image-validation.js';
import { createChatTurnTracker } from './chat-turn-tracker.js';
import { createChatAgentRoutes } from './chat-agent-routes.js';
import { createChatThreadRoutes } from './chat-thread-routes.js';
import { createChatMessageRoutes } from './chat-message-routes.js';
import { createChatMessageStreamRoutes } from './chat-message-stream-routes.js';

export const CHAT_CSRF_DENIED = 'cross-site chat request blocked';
export const CHAT_NOT_AUTHORIZED =
  'chat requires local access or an authorized tunnel session';
export const DEFAULT_CHAT_AVAILABILITY_CACHE_MS = 60_000;

// bdboard-sso1.17: chat-routes.ts (730行, 分割前 1015行) を、リソース別の登録関数
// (chat-agent-routes.ts / chat-thread-routes.ts / chat-message-routes.ts /
// chat-message-stream-routes.ts ) へ分割した (move
// only, 挙動変更ゼロ)。このファイルは合成層として残り、公開 API
// (createChatRoutes・ChatRoutesDeps・下記の定数群) は分割前と同一。トップレベルの
// ミドルウェア (chatGuard・chatMessageBodyLimit・rateLimit・
// discoverySessionsLocalOnlyGuard) はどのグループを跨いで適用順が変わっても
// いけないため、ここに残したまま各グループのルート登録より先に呼ぶ
// (元のファイルでの並び : ミドルウェア8件 → ルート12件、をそのまま維持)。
export interface ChatRoutesDeps {
  readonly cache: BoardCache;
  readonly agents: ChatAgentRegistry;
  readonly store: ChatSessionStore;
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

// 104.12 で着地した、子プロセスを起こさない GET(SQLite/インメモリ読み取りのみ)の免除。
const CHAT_SESSION_MESSAGES_PATH_PATTERN = /^\/api\/chat\/sessions\/[^/]+\/messages$/;
const CHAT_THREADS_PATH_PATTERN = /^\/api\/chat\/threads$/;
const CHAT_TURN_STATUS_PATH_PATTERN = /^\/api\/chat\/turn-status$/;

const CHAT_RATE_LIMIT_EXEMPT_PATH_PATTERNS: readonly ChatRateLimitExemptPattern[] = [
  { method: 'GET', pattern: CHAT_SESSION_MESSAGES_PATH_PATTERN },
  { method: 'GET', pattern: CHAT_THREADS_PATH_PATTERN },
  { method: 'GET', pattern: CHAT_TURN_STATUS_PATH_PATTERN },
  { method: 'DELETE', pattern: CHAT_TURN_STATUS_PATH_PATTERN },
];

export { CHAT_STREAM_QUEUE_MAX_SIZE } from './chat-message-stream-routes.js';

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
  // bdboard-3tw.165 系の completed/failed ターンキュー。GET/DELETE turn-status と
  // POST message(/stream) の両方が読み書きするため、所有者をここに1つだけ作り、
  // 両グループへそのまま渡す(状態を複製しない)。
  const turnTracker = createChatTurnTracker(now);
  const rateLimit = createChatRateLimitMiddleware(limiter, {
    // /api/chat/agents は免除しない: 1 リクエストで N 個の --version 子プロセスを
    // 起こしうる増幅があるため、ミドルウェアの per-request カウントで抑える。
    exemptPaths: ['/api/chat/availability'],
    // 以下は claude CLI などの子プロセスを起動せず、SQLite/インメモリを読むだけなので、
    // トンネル経由でもレート課金から除外する。認証ガード(chatGuard)は引き続き通す。
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

  app.route('/', createChatAgentRoutes(deps, { now, availabilityCacheMs, limiter }));
  app.route('/', createChatThreadRoutes(deps, turnTracker));
  app.route('/', createChatMessageRoutes(deps, { now, turnTracker }));
  app.route('/', createChatMessageStreamRoutes(deps, { now, turnTracker }));

  return app;
}
