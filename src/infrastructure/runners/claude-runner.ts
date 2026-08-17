// v1 is read-only (PLAN.md safety guarantee). Real dispatch is intentionally
// unimplemented; this module does not launch subprocesses. The command is built
// so it can be asserted in tests, and then reported back as a "would run:" string.
import type {
  AgentRunner,
  RunOutcome,
  RunRequest,
} from '../../application/ports/agent-runner.js';
import { buildClaudeCommand } from '../../application/runner/build-claude-args.js';
import type { RunMode } from '../../domain/run.js';

export interface ClaudeRunnerOptions {
  readonly claudePath?: string;
}

function buildRunId(request: RunRequest, startedAt: Date): string {
  return `${request.ticketId}:${request.mode}:${startedAt.toISOString()}`;
}

function buildOutcome(
  runnerId: string,
  request: RunRequest,
  startedAt: Date,
  failureKind: RunOutcome['failureKind'],
  error: string,
): RunOutcome {
  return {
    ok: false,
    failureKind,
    error,
    run: {
      id: buildRunId(request, startedAt),
      ticketId: request.ticketId,
      runner: runnerId,
      mode: request.mode,
      status: 'failed',
      startedAt,
      finishedAt: startedAt,
      sessionId: request.sessionId,
    },
  };
}

/**
 * Shared factory for the official `claude` runners. `spawn` and `resume` differ
 * only in which mode they accept and in their id; keeping one implementation
 * prevents the two from drifting apart when dispatch is eventually implemented.
 */
export function createClaudeRunner(
  id: string,
  mode: RunMode,
  options?: ClaudeRunnerOptions,
): AgentRunner {
  // Claude must be launched through a wrapper's full path. The path comes from the
  // environment at construction time rather than being hardcoded per machine.
  const claudePath = options?.claudePath ?? process.env.BDBOARD_CLAUDE_PATH ?? 'claude';

  return {
    id,
    experimental: false,
    supports: (request: RunRequest) => request.mode === mode,
    async dispatch(request: RunRequest): Promise<RunOutcome> {
      const startedAt = new Date();

      let command: string;
      let args: readonly string[];
      try {
        ({ command, args } = buildClaudeCommand(request, { claudePath }));
      } catch (error: unknown) {
        // `dispatch` must never throw: the port contract is that callers get an
        // outcome they can fall back from. A build failure means the request was
        // malformed (e.g. resume without a session id).
        const detail = error instanceof Error ? error.message : String(error);
        return buildOutcome(id, request, startedAt, 'invalid-request', detail);
      }

      return buildOutcome(
        id,
        request,
        startedAt,
        'dispatch-disabled',
        `dispatch disabled (v1 read-only): would run: ${command} ${args.join(' ')}`,
      );
    },
  };
}
