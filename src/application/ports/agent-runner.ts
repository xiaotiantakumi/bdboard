// Real dispatch is gated at the HTTP layer (agent-run-guard on POST /api/runs).
// Implementations may launch processes only when wired with a StreamingCommandRunner.
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

export interface RunOutputSink {
  readonly onChunk: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
  readonly signal?: AbortSignal;
}

export type RunFailureKind =
  | 'dispatch-disabled' // runner not wired for real dispatch
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
  dispatch(request: RunRequest, sink?: RunOutputSink): Promise<RunOutcome>;
}
