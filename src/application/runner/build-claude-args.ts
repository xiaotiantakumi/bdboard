import type { RunRequest } from '../ports/agent-runner.js';

export interface ClaudeCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Thrown when a resume request carries no session id.
 *
 * Silently dropping `--resume` would turn a "continue this session" request into
 * a command identical to a fresh spawn. Once dispatch is real, that means a brand
 * new agent starting in the project directory instead of the intended resume, so
 * this must fail loudly rather than degrade. `validateRunRequest` normally rejects
 * such requests first; this is the second line of defence.
 */
export class MissingSessionIdError extends Error {
  constructor() {
    super('resume requires a non-empty sessionId');
    this.name = 'MissingSessionIdError';
  }
}

export function buildClaudeCommand(
  request: RunRequest,
  options?: { readonly claudePath?: string },
): ClaudeCommand {
  const command = options?.claudePath ?? 'claude';

  const args: string[] = [];

  if (request.mode === 'resume') {
    if (request.sessionId === undefined || request.sessionId.trim() === '') {
      throw new MissingSessionIdError();
    }
    args.push('--resume', request.sessionId);
  }

  if (request.prompt !== undefined && request.prompt !== '') {
    // No shell quoting or escaping: args are passed directly to execFile-style
    // invocation without a shell, so each element is one argv token as-is.
    args.push(request.prompt);
  }

  return { command, args };
}
