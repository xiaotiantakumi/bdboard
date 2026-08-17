// v1 is read-only. Implementations of this port must not launch real processes.
import type { Run, RunMode } from '../../domain/run.js';
import type { TicketId } from '../../domain/ticket-id.js';

export interface RunRequest {
  readonly ticketId: TicketId;
  readonly projectId: string;
  /** Working directory for the run (e.g. project rootPath). */
  readonly cwd: string;
  readonly mode: RunMode;
  /** Required when mode === 'resume'. */
  readonly sessionId?: string;
  readonly prompt?: string;
}

export type RunFailureKind =
  | 'dispatch-disabled' // v1: intentionally disabled
  | 'unsupported' // this runner cannot handle the request
  | 'invalid-request' // malformed request (e.g. resume without sessionId)
  | 'runner-unavailable' // runner binary not found
  | 'failed'; // dispatch ran but failed

export interface RunOutcome {
  readonly ok: boolean;
  readonly run: Run;
  readonly failureKind?: RunFailureKind;
  readonly error?: string;
}

export interface AgentRunner {
  readonly id: string;
  /** True for adapters that depend on private APIs; used for UI/registration warnings. */
  readonly experimental: boolean;
  supports(request: RunRequest): boolean;
  dispatch(request: RunRequest): Promise<RunOutcome>;
}
