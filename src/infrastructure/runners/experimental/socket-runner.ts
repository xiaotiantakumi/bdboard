// `/tmp/cc-socks/<pid>.sock` uses private IPC with `peerProtocol: 1` and can break
// without notice on Claude Code version updates. Official interrupt paths were
// confirmed impossible in practice. This adapter is therefore isolated as
// experimental and must only be used in a form that can fall back to spawn/resume.
// v1 writes no connection code at all.
import type {
  AgentRunner,
  RunOutcome,
  RunRequest,
} from '../../../application/ports/agent-runner.js';

function buildRunId(request: RunRequest, startedAt: Date): string {
  return `${request.ticketId}:${request.mode}:${startedAt.toISOString()}`;
}

export function createExperimentalSocketRunner(): AgentRunner {
  return {
    id: 'experimental-socket',
    experimental: true,
    supports: (request: RunRequest) => request.mode === 'resume',
    async dispatch(request: RunRequest): Promise<RunOutcome> {
      const startedAt = new Date();
      return {
        ok: false,
        failureKind: 'dispatch-disabled',
        error:
          'dispatch disabled (v1 read-only): experimental socket runner does not connect',
        run: {
          id: buildRunId(request, startedAt),
          ticketId: request.ticketId,
          runner: 'experimental-socket',
          mode: request.mode,
          status: 'failed',
          startedAt,
          finishedAt: startedAt,
          sessionId: request.sessionId,
        },
      };
    },
  };
}
