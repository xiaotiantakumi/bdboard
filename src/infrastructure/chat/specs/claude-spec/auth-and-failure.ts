import { z } from 'zod';
import type {
  ChatAgentAvailability,
  ChatFailureCode,
} from '../../../../application/ports/chat-agent.js';
import { describeClaudeSettingSourcesFailure } from '../../../../domain/claude-version-check.js';
import type { CommandResult } from '../../../../application/ports/command-runner.js';

/** `claude auth status --json` の出力。使うのは loggedIn だけなので passthrough でよい。 */
const claudeAuthStatusSchema = z.object({
  loggedIn: z.boolean(),
});

export function interpretClaudeAuthProbe(result: CommandResult): ChatAgentAvailability {
  if (result.failureKind === 'timeout') {
    return 'unknown';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // `auth status` を持たない古い CLI などはここに来る。
    // 判断がつかないので 'unavailable' とも 'available' とも言わない。
    return 'unknown';
  }

  const validated = claudeAuthStatusSchema.safeParse(parsed);
  if (!validated.success) {
    return 'unknown';
  }

  return validated.data.loggedIn ? 'available' : 'unavailable';
}

// bdboard-ndky: 古い claude CLI が --setting-sources を未知オプションとして拒否した
// stderr だけを describeClaudeSettingSourcesFailure() で読み取り、固定コードに翻訳する。
// stderr の生テキストは返さない(bdboard-pvl)。failureKind がある場合は spawn/timeout 分類を優先。
export function classifyClaudeFailure(result: CommandResult): ChatFailureCode | undefined {
  if (result.failureKind !== undefined) {
    return undefined;
  }
  if (describeClaudeSettingSourcesFailure(result.stderr) !== null) {
    return 'agent-claude-cli-too-old';
  }
  return undefined;
}
