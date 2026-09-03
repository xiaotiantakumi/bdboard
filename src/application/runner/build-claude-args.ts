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
  options?: {
    readonly claudePath?: string;
    readonly permissionMode?: string;
    readonly allowedTools?: readonly string[];
  },
): ClaudeCommand {
  const command = options?.claudePath ?? 'claude';

  const args: string[] = [];

  if (request.mode === 'resume') {
    if (request.sessionId === undefined || request.sessionId.trim() === '') {
      throw new MissingSessionIdError();
    }
    args.push('--resume', request.sessionId);
  }

  const prompt = request.prompt;
  const hasPrompt = prompt !== undefined && prompt !== '';

  // `-p` is only added for spawn. Resume does not get `-p` today; resume wiring is
  // not landed yet so there is no live resume path, but when dispatch adds it we
  // must confirm whether Claude expects `-p` on `--resume` or treats the trailing
  // prompt differently.
  if (request.mode === 'spawn' && hasPrompt) {
    args.push('-p');
  }

  if (options?.permissionMode !== undefined && options.permissionMode !== '') {
    args.push('--permission-mode', options.permissionMode);
  }

  const allowedTools = options?.allowedTools;
  if (allowedTools !== undefined && allowedTools.length > 0) {
    args.push('--allowedTools', ...allowedTools);
  }

  if (hasPrompt) {
    // `--` terminates option parsing before the positional prompt.
    //
    // This is load-bearing, not cosmetic: `claude --help` documents
    // `--allowedTools, --allowed-tools <tools...>` as *variadic*, so without a
    // terminator it greedily consumes every following non-option argv token —
    // including the prompt. Measured against claude CLI 2.1.233: the prompt was
    // absorbed as another tool name and the CLI exited 1 with
    // "Input must be provided either through stdin or as a prompt argument when
    // using --print". `--` fixes it regardless of which variadic options are
    // present, so it is emitted unconditionally whenever there is a prompt.
    args.push('--');

    // No shell quoting or escaping: args are passed directly to execFile-style
    // invocation without a shell, so each element is one argv token as-is.
    args.push(prompt);
  }

  return { command, args };
}
