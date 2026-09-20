// bdboard-sso1.29: claude-runner.ts から move-only で分割。
// ClaudeRunnerOptions は resolveTimeoutMs / resolvePermissionMode / resolveAllowedTools /
// createClaudeRunner が共有するオプション型で、循環 import を避けるため単独ファイルに置く。
import type { StreamingCommandRunner } from '../../../application/ports/streaming-command-runner.js';

export interface ClaudeRunnerOptions {
  readonly claudePath?: string;
  readonly streamingRunner?: StreamingCommandRunner;
  readonly permissionMode?: string;
  readonly allowedTools?: readonly string[];
  readonly timeoutMs?: number;
}
