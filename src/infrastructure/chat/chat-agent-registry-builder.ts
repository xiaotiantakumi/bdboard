import {
  createChatAgentRegistry,
  type ChatAgentRegistry,
} from '../../application/chat/chat-agent-registry.js';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { StreamingCommandRunner } from '../../application/ports/streaming-command-runner.js';
import { isChatAgentOptedIn, parseChatAgentOptIns } from './chat-agent-gate.js';
import { createClaudeChatAgent } from './claude-chat-agent.js';
import { createCodexChatAgent } from './codex-chat-agent.js';
import { createCursorChatAgent } from './cursor-chat-agent.js';
import { createAgyChatAgent } from './agy-chat-agent.js';

function envString(env: NodeJS.ProcessEnv, name: string, defaultValue: string): string {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  return raw;
}

function envInt(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * env が未設定/不正なら `undefined` を返す(既定値は呼ばない — bdboard-3tw.104.11 Opus
 * レビュー N2)。重みの既定値適用は「重み宣言元 = spec」の原則に忠実に claude-spec.ts の
 * `resolveClaudeModelWeights` 側の `??` に一本化してあるので、ここで defaultValue を渡して
 * 二重に既定値を宣言しない。
 *
 * `> 0` を要求するのは N4: 負値/0 の env を受理すると、その値がそのまま
 * descriptor.models[].weight に載って起動ログや UI に「実態と異なる重み」を見せてしまう
 * (chat-rate-limit.ts の normalizeWeight による <=0 クランプは limiter.consume() 時にしか
 * 効かず、descriptor の値そのものは直さない)。ここで弾いて既定へフォールバックさせる。
 */
function envFloat(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export interface ChatAgentRegistryBuildResult {
  readonly registry: ChatAgentRegistry;
  /** codex アダプタが今回の env で opt-in されて登録されたかどうか。呼び出し元のログ出し分けに使う。 */
  readonly codexEnabled: boolean;
  /** cursor アダプタが今回の env で opt-in されて登録されたかどうか。呼び出し元のログ出し分けに使う(bdboard-l1t.5)。 */
  readonly cursorEnabled: boolean;
  /** agy アダプタが opt-in されて登録されたかどうか(bdboard-l1t.6)。 */
  readonly agyEnabled: boolean;
}

/**
 * main.ts のチャットエージェント登録配線を切り出したもの(bdboard-l1t.4 SF6)。
 * claude は常時登録、codex/cursor/agy は BDBOARD_CHAT_AGENTS への明示 opt-in がある時だけ登録する。
 *
 * codex/cursor は claude と違い「組み込みツールを全部外して bd MCP だけ残す」機能が無く、
 * 実際には shell/ファイル読み書きが使えてしまう(capability: 'unrestricted')。cursor は
 * さらに bd MCP ツールそのものを一切接続できない(cursor-chat-agent.ts のコメント参照)。
 * bdboard-9a9 の裁定でこの権限差自体は許容されたが、既定でチャットの安全前提が
 * 変わるのは避けたいので、BDBOARD_CHAT_AGENTS への明示 opt-in が無い限り登録しない。
 *
 * env を引数で受け取る(process.env を直接読まない)ので、テストからグローバル状態を
 * 書き換えずに `{}` / `{ BDBOARD_CHAT_AGENTS: 'codex' }` のような入力を直接検証できる。
 */
export function buildChatAgentRegistry(
  env: NodeJS.ProcessEnv,
  commandRunner: CommandRunner,
  streamingCommandRunner?: StreamingCommandRunner,
): ChatAgentRegistryBuildResult {
  const registry = createChatAgentRegistry();
  registry.register(
    createClaudeChatAgent(commandRunner, {
      claudePath: envString(env, 'BDBOARD_CLAUDE_PATH', 'claude'),
      model: envString(env, 'BDBOARD_CHAT_MODEL', 'sonnet'),
      timeoutMs: envInt(env, 'BDBOARD_CHAT_TIMEOUT_MS', 180_000),
      bdPath: envString(env, 'BDBOARD_BD_PATH', 'bd'),
      // BDBOARD_CHAT_RATE_WEIGHT_OPUS/SONNET/HAIKU は claude の各モデルに対応する spec が
      // ここにあるので、ここで読んで claude-spec.ts へ橋渡しする。BDBOARD_CHAT_RATE_WEIGHT_DEFAULT
      // だけはここに無い — 「未知モデル/重み未宣言モデル全般」のフォールバック値であって特定の
      // spec に帰属しないため、main.ts が chat-routes.ts の defaultWeight として直接読む
      // (bdboard-3tw.104.11 Opus レビュー SF4)。
      modelWeights: {
        opus: envFloat(env, 'BDBOARD_CHAT_RATE_WEIGHT_OPUS'),
        sonnet: envFloat(env, 'BDBOARD_CHAT_RATE_WEIGHT_SONNET'),
        haiku: envFloat(env, 'BDBOARD_CHAT_RATE_WEIGHT_HAIKU'),
      },
    }, streamingCommandRunner),
  );

  const chatAgentOptIns = parseChatAgentOptIns(env.BDBOARD_CHAT_AGENTS);
  const codexEnabled = isChatAgentOptedIn('codex', chatAgentOptIns);
  if (codexEnabled) {
    registry.register(
      createCodexChatAgent(commandRunner, {
        codexPath: envString(env, 'BDBOARD_CODEX_PATH', 'codex'),
        model: envString(env, 'BDBOARD_CODEX_MODEL', ''),
        timeoutMs: envInt(env, 'BDBOARD_CHAT_TIMEOUT_MS', 180_000),
        bdPath: envString(env, 'BDBOARD_BD_PATH', 'bd'),
      }),
    );
  }

  const cursorEnabled = isChatAgentOptedIn('cursor', chatAgentOptIns);
  if (cursorEnabled) {
    registry.register(
      createCursorChatAgent(commandRunner, {
        cursorPath: envString(env, 'BDBOARD_CURSOR_PATH', 'cursor-agent'),
        model: envString(env, 'BDBOARD_CURSOR_MODEL', ''),
        timeoutMs: envInt(env, 'BDBOARD_CHAT_TIMEOUT_MS', 180_000),
        bdPath: envString(env, 'BDBOARD_BD_PATH', 'bd'),
      }),
    );
  }

  const agyEnabled = isChatAgentOptedIn('agy', chatAgentOptIns);
  if (agyEnabled) {
    registry.register(
      createAgyChatAgent(commandRunner, {
        agyPath: envString(env, 'BDBOARD_AGY_PATH', 'agy'),
        model: envString(env, 'BDBOARD_AGY_MODEL', ''),
        timeoutMs: envInt(env, 'BDBOARD_CHAT_TIMEOUT_MS', 180_000),
        bdPath: envString(env, 'BDBOARD_BD_PATH', 'bd'),
      }),
    );
  }

  return { registry, codexEnabled, cursorEnabled, agyEnabled };
}
