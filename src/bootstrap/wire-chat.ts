/**
 * bdboard-sso1.14: src/main.ts (composition root) からチャット領域の配線を
 * 切り出したもの (move only, 挙動変更ゼロ)。
 *
 * BDBOARD_CHAT_DISABLED による無効化・登録配線 (claude 常時登録 /
 * codex・cursor・agy は opt-in)・SQLite リポジトリ・レート制限 env の解決・
 * ルーターの組み立てまでを担う。
 */
import type { Hono } from 'hono';
import type { BoardCache } from '../application/ports/board-cache.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';
import type { CommandRunner } from '../application/ports/command-runner.js';
import type { StreamingCommandRunner } from '../application/ports/streaming-command-runner.js';
import type { ChatSessionDiscoveryPort } from '../application/ports/chat-session-discovery.js';
import { buildChatAgentRegistry } from '../infrastructure/chat/chat-agent-registry-builder.js';
import { createChatSessionStore } from '../application/chat/chat-session-store.js';
import {
  createSqliteChatMessageRepository,
  createSqliteChatSessionRepository,
} from '../infrastructure/index.js';
import { createChatRoutes } from '../interface/http/chat-routes.js';
import {
  DEFAULT_CHAT_RATE_LIMIT_WEIGHT,
  DEFAULT_CHAT_RATE_LIMIT_PER_DAY,
  DEFAULT_CHAT_RATE_LIMIT_PER_MINUTE,
} from '../interface/http/chat-rate-limit.js';
import { envFloat, envInt } from '../infrastructure/env.js';

export interface WireChatDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly chatDisabled: boolean;
  readonly cache: BoardCache;
  readonly chatSessionDiscovery: ChatSessionDiscoveryPort;
  readonly dbPath: string;
  readonly commandRunner: CommandRunner;
  readonly streamingCommandRunner: StreamingCommandRunner;
  readonly writeAccess: WriteGuardDeps;
  readonly log?: (message: string) => void;
}

export interface WireChatResult {
  readonly chatRouter: Hono | undefined;
  readonly chatCloseables: { readonly close: () => void }[];
}

export function wireChat(deps: WireChatDeps): WireChatResult {
  const log = deps.log ?? console.log;
  const chatCloseables: { readonly close: () => void }[] = [];

  if (deps.chatDisabled) {
    log('Chat: disabled');
    return { chatRouter: undefined, chatCloseables };
  }

  // 登録配線そのもの(claude 常時登録 / codex・cursor は opt-in 時のみ)は
  // chat-agent-registry-builder.ts に切り出してユニットテスト可能にしてある
  // (bdboard-l1t.4 SF6, cursor は bdboard-l1t.5)。ここでは env を渡して呼ぶだけにする。
  const {
    registry: chatAgentRegistry,
    codexEnabled,
    cursorEnabled,
    agyEnabled,
  } = buildChatAgentRegistry(deps.env, deps.commandRunner, deps.streamingCommandRunner);
  if (codexEnabled) {
    log('Chat: codex adapter enabled via BDBOARD_CHAT_AGENTS opt-in (bdboard-l1t.4)');
  }
  if (cursorEnabled) {
    log('Chat: cursor adapter enabled via BDBOARD_CHAT_AGENTS opt-in (bdboard-l1t.5)');
  }
  if (agyEnabled) {
    log('Chat: agy adapter enabled via BDBOARD_CHAT_AGENTS opt-in (bdboard-l1t.6)');
  }
  const chatAgent = chatAgentRegistry.defaultAgent();
  if (chatAgent === undefined) {
    throw new Error('chat agent registry has no registered agents');
  }
  const chatSessionRepository = createSqliteChatSessionRepository(deps.dbPath);
  const chatMessageRepository = createSqliteChatMessageRepository(deps.dbPath);
  chatCloseables.push(chatSessionRepository, chatMessageRepository);
  const chatStore = createChatSessionStore({ repository: chatSessionRepository });
  const chatPerMinute = envInt(
    deps.env,
    'BDBOARD_CHAT_TUNNEL_RATE_PER_MINUTE',
    DEFAULT_CHAT_RATE_LIMIT_PER_MINUTE,
  );
  const chatPerDay = envInt(
    deps.env,
    'BDBOARD_CHAT_TUNNEL_LIMIT_PER_DAY',
    DEFAULT_CHAT_RATE_LIMIT_PER_DAY,
  );
  const chatDefaultWeight = envFloat(
    deps.env,
    'BDBOARD_CHAT_RATE_WEIGHT_DEFAULT',
    DEFAULT_CHAT_RATE_LIMIT_WEIGHT,
  );

  const chatRouter = createChatRoutes({
    cache: deps.cache,
    agents: chatAgentRegistry,
    store: chatStore,
    sessionDiscovery: deps.chatSessionDiscovery,
    messages: chatMessageRepository,
    writeAccess: deps.writeAccess,
    rateLimit: {
      perMinute: chatPerMinute,
      perDay: chatPerDay,
      defaultWeight: chatDefaultWeight,
    },
  });

  log('Chat: enabled (local, or a tunnel session from the QR when the tunnel password is strong)');
  const defaultAgentModels = chatAgentRegistry.defaultAgent()?.descriptor.models;
  const modelWeightsLog =
    defaultAgentModels !== undefined && defaultAgentModels.length > 0
      ? ` (${defaultAgentModels
          .map((entry) => `${entry.id} x${entry.weight ?? chatDefaultWeight}`)
          .join(', ')})`
      : '';
  log(`Chat rate limit (tunnel only): ${chatPerMinute}/min, ${chatPerDay}/day${modelWeightsLog}`);

  return { chatRouter, chatCloseables };
}
