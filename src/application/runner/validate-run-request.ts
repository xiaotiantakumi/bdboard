import type { RunFailureKind, RunRequest } from '../ports/agent-runner.js';

export function validateRunRequest(request: RunRequest): RunFailureKind | null {
  if (request.ticketId.trim() === '') {
    return 'invalid-request';
  }

  if (request.cwd.trim() === '') {
    return 'invalid-request';
  }

  if (
    request.mode === 'resume' &&
    (request.sessionId === undefined || request.sessionId.trim() === '')
  ) {
    return 'invalid-request';
  }

  return null;
}
