// bdboard-sso1.29: claude-runner.ts から move-only で分割。
// RunOutcome の組み立てヘルパーとタイムアウト解決。
import type { RunOutcome, RunRequest } from '../../../application/ports/agent-runner.js';
import type { ClaudeRunnerOptions } from './options.js';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

export function buildClaudeRunId(request: RunRequest, startedAt: Date): string {
  return `${request.ticketId}:${request.mode}:${startedAt.toISOString()}`;
}

export function buildOutcome(
  runnerId: string,
  request: RunRequest,
  startedAt: Date,
  failureKind: RunOutcome['failureKind'],
  error: string,
  status: RunOutcome['run']['status'] = 'failed',
): RunOutcome {
  return {
    ok: false,
    failureKind,
    error,
    run: {
      id: buildClaudeRunId(request, startedAt),
      ticketId: request.ticketId,
      runner: runnerId,
      mode: request.mode,
      status,
      startedAt,
      finishedAt: startedAt,
      sessionId: request.sessionId,
    },
  };
}

export function resolveTimeoutMs(options?: ClaudeRunnerOptions): number {
  if (options?.timeoutMs !== undefined) {
    return options.timeoutMs;
  }

  const fromEnv = process.env.BDBOARD_RUN_TIMEOUT_MS;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_TIMEOUT_MS;
}
