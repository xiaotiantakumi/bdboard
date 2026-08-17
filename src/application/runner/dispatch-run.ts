import type { RunOutcome, RunRequest } from '../ports/agent-runner.js';
import type { AgentRunnerRegistry } from './runner-registry.js';
import { validateRunRequest } from './validate-run-request.js';

function buildRunId(
  ticketId: string,
  mode: RunRequest['mode'],
  startedAt: Date,
): string {
  return `${ticketId}:${mode}:${startedAt.toISOString()}`;
}

function buildInvalidRequestOutcome(
  request: RunRequest,
  now: Date,
): RunOutcome {
  // No runner is consulted for invalid requests; runner id is a sentinel value.
  return {
    ok: false,
    failureKind: 'invalid-request',
    run: {
      id: buildRunId(request.ticketId, request.mode, now),
      ticketId: request.ticketId,
      runner: 'none',
      mode: request.mode,
      status: 'failed',
      startedAt: now,
      finishedAt: now,
      sessionId: request.sessionId,
    },
  };
}

function buildUnsupportedOutcome(
  request: RunRequest,
  now: Date,
): RunOutcome {
  return {
    ok: false,
    failureKind: 'unsupported',
    run: {
      id: buildRunId(request.ticketId, request.mode, now),
      ticketId: request.ticketId,
      runner: 'none',
      mode: request.mode,
      status: 'failed',
      startedAt: now,
      finishedAt: now,
      sessionId: request.sessionId,
    },
  };
}

export async function dispatchRun(
  registry: AgentRunnerRegistry,
  request: RunRequest,
  now: () => Date,
): Promise<RunOutcome> {
  const validationError = validateRunRequest(request);
  if (validationError !== null) {
    const timestamp = now();
    return buildInvalidRequestOutcome(request, timestamp);
  }

  const runners = registry.resolve(request);
  if (runners.length === 0) {
    const timestamp = now();
    return buildUnsupportedOutcome(request, timestamp);
  }

  let lastOutcome: RunOutcome | undefined;
  let lastExceptionMessage: string | undefined;

  for (const runner of runners) {
    try {
      const outcome = await runner.dispatch(request);
      if (outcome.ok) {
        return outcome;
      }
      lastOutcome = outcome;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      lastExceptionMessage = message;
    }
  }

  if (lastOutcome !== undefined) {
    return lastOutcome;
  }

  const timestamp = now();
  return {
    ok: false,
    failureKind: 'failed',
    error: lastExceptionMessage,
    run: {
      id: buildRunId(request.ticketId, request.mode, timestamp),
      ticketId: request.ticketId,
      runner: 'none',
      mode: request.mode,
      status: 'failed',
      startedAt: timestamp,
      finishedAt: timestamp,
      sessionId: request.sessionId,
    },
  };
}
