import type { RunOutcome } from '../../ports/agent-runner.js';
import type { RunMode, RunStatus } from '../../../domain/run.js';
import type { TicketId } from '../../../domain/ticket-id.js';

export interface RunStoreStartEntry {
  readonly id: string;
  readonly ticketId: TicketId;
  readonly runner: string;
  readonly mode: RunMode;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly startedAt?: Date;
}

export interface RunStoreRecord {
  readonly id: string;
  readonly ticketId: TicketId;
  readonly runner: string;
  readonly mode: RunMode;
  readonly cwd: string;
  readonly status: RunStatus;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly sessionId?: string;
  readonly exitCode?: number;
  readonly error?: string;
  readonly log: string;
}

export interface RunStoreListFilter {
  readonly ticketId?: TicketId;
  readonly status?: RunStatus;
}

export type RunStoreCanStartResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'already-running' | 'too-many-runs';
    };

export interface RunStore {
  canStart(ticketId: TicketId): RunStoreCanStartResult;
  start(entry: RunStoreStartEntry): RunStoreRecord;
  updateCwd(runId: string, cwd: string): RunStoreRecord | undefined;
  appendChunk(
    runId: string,
    chunk: { stream: 'stdout' | 'stderr'; text: string },
  ): RunStoreRecord | undefined;
  finish(runId: string, outcome: RunOutcome): RunStoreRecord | undefined;
  cancel(runId: string): RunStoreRecord | undefined;
  cancelAll(): readonly RunStoreRecord[];
  /**
   * 走っている run をすべて cancel し、各 run の完了（finish もしくは強制 cancelled）まで待つ。
   * timeoutMs を超えたら待つのをやめて resolve する（シャットダウンをハングさせない）。
   *
   * 子プロセスは detached で別プロセスグループにいるため、サーバーのプロセスグループ宛ての
   * SIGTERM は届かない。abort 後 STOP_GRACE_MS(3s) の猶予を経て SIGKILL されるが、drain が
   * それを待たずにプロセスを終えると SIGTERM を無視する CLI が孤児として編集を続ける
   * (bdboard-54be.1)。
   */
  cancelAllAndWait(timeoutMs: number): Promise<void>;
  get(runId: string): RunStoreRecord | undefined;
  list(filter?: RunStoreListFilter): readonly RunStoreRecord[];
  /** Signal wired into RunOutputSink when dispatching a started run. */
  getAbortSignal(runId: string): AbortSignal | undefined;
}

export interface RunStoreOptions {
  readonly maxConcurrent?: number;
  readonly maxRetainedRuns?: number;
  readonly maxLogBytes?: number;
  readonly now?: () => Date;
  readonly cancellingGraceMs?: number;
}

export interface InternalRunRecord {
  readonly id: string;
  readonly ticketId: TicketId;
  readonly runner: string;
  readonly mode: RunMode;
  cwd: string;
  status: RunStatus;
  readonly startedAt: Date;
  finishedAt?: Date;
  sessionId?: string;
  exitCode?: number;
  error?: string;
  /** cancelling へ遷移した時刻（公開 DTO には載せない） */
  cancellingAt?: Date;
}

export interface RunCompletionDeferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

export interface InternalRunEntry {
  record: InternalRunRecord;
  logChunks: string[];
  logBytes: number;
  abortController: AbortController;
  completionDeferred: RunCompletionDeferred;
}
