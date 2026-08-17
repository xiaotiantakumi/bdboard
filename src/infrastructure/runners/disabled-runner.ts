// v1 is read-only (PLAN.md safety guarantee). Real dispatch is intentionally unimplemented;
// this module does not launch subprocesses.
import type {
  AgentRunner,
  RunOutcome,
  RunRequest,
} from '../../application/ports/agent-runner.js';

function buildRunId(request: RunRequest, startedAt: Date): string {
  return `${request.ticketId}:${request.mode}:${startedAt.toISOString()}`;
}

function buildDisabledOutcome(
  runnerId: string,
  request: RunRequest,
  startedAt: Date,
  error: string,
): RunOutcome {
  return {
    ok: false,
    failureKind: 'dispatch-disabled',
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

export function createDisabledRunner(
  id: string,
  options?: { readonly experimental?: boolean },
): AgentRunner {
  const experimental = options?.experimental ?? false;

  return {
    id,
    experimental,
    supports: () => true,
    async dispatch(request: RunRequest): Promise<RunOutcome> {
      const startedAt = new Date();
      return buildDisabledOutcome(
        id,
        request,
        startedAt,
        `dispatch disabled (v1 read-only): runner ${id}`,
      );
    },
  };
}
