// bdboard-sso1.29: claude-runner.ts から move-only で分割。
// claude CLI のバージョン probe とプロセス寿命キャッシュ。
import type { StreamingCommandRunner } from '../../../application/ports/streaming-command-runner.js';
import {
  evaluateClaudeVersion,
  type ClaudeVersionCheck,
} from '../../../domain/claude-version-check.js';
import { buildRunnerEnv } from './runner-env.js';

const CLAUDE_VERSION_PROBE_TIMEOUT_MS = 10_000;

const claudeVersionCache = new Map<string, Promise<ClaudeVersionCheck>>();

async function probeClaudeVersion(
  streamingRunner: StreamingCommandRunner,
  claudePath: string,
): Promise<ClaudeVersionCheck> {
  try {
    const result = await streamingRunner.run(claudePath, ['--version'], {
      env: buildRunnerEnv(),
      timeoutMs: CLAUDE_VERSION_PROBE_TIMEOUT_MS,
      onChunk: () => {},
    });

    if (result.failureKind !== undefined || result.exitCode !== 0) {
      return evaluateClaudeVersion(null);
    }

    return evaluateClaudeVersion(result.stdout);
  } catch {
    return evaluateClaudeVersion(null);
  }
}

export function resolveClaudeVersionCheck(
  streamingRunner: StreamingCommandRunner,
  claudePath: string,
): Promise<ClaudeVersionCheck> {
  const cached = claudeVersionCache.get(claudePath);
  if (cached !== undefined) {
    return cached;
  }

  const pending = probeClaudeVersion(streamingRunner, claudePath);
  claudeVersionCache.set(claudePath, pending);
  return pending;
}

/** テスト専用。プロセス寿命キャッシュを捨てる。 */
export function resetClaudeVersionCacheForTests(): void {
  claudeVersionCache.clear();
}
