// bdboard-sso1.32: cli-chat-agent.ts の実装本体は
// src/infrastructure/chat/cli-chat-agent/*.ts へ move-only で分割した。
// このファイルは合成/re-export のみの入口として残す。
export type {
  CliMcpServerSpec,
  CliTurnContext,
  CliTurnPlan,
  CliAuthProbe,
  CliChatAgentSpec,
  CliChatAgentDeps,
} from './cli-chat-agent/types.js';
export { createCliChatAgent } from './cli-chat-agent/create-cli-chat-agent.js';
