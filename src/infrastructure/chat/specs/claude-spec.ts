// bdboard-sso1.45: claude-spec.ts の実装本体は
// src/infrastructure/chat/specs/claude-spec/*.ts へ move-only で分割した。
// このファイルは合成/re-export のみの入口として残す。
export { CLAUDE_ENV_ALLOWLIST } from './claude-spec/env.js';
export {
  DEFAULT_CLAUDE_MODEL_WEIGHTS,
  DEFAULT_CLAUDE_MODEL_IDS,
  CLAUDE_CHAT_MODELS,
  type ClaudeModelWeights,
} from './claude-spec/models.js';
export { createClaudeSpec, type ClaudeSpecOptions } from './claude-spec/create-claude-spec.js';
