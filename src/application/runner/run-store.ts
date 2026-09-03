import type { RunOutcome } from '../ports/agent-runner.js';
import type { RunMode, RunStatus } from '../../domain/run.js';
import type { TicketId } from '../../domain/ticket-id.js';

// Each run prompt ends with npm run verify, which acquires one of two machine-local
// verify slots — raising concurrent runs starves the operator's own verifies.
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_RETAINED_RUNS = 50;
const DEFAULT_MAX_LOG_BYTES = 512 * 1024;

/**
 * node-streaming-command-runner.ts の STOP_GRACE_MS(3s、SIGTERM→SIGKILL の猶予) に
 * マージンを足した値。infrastructure の定数を application から import すると
 * レイヤー境界を割るので、値の同期はコメントで担保する (bdboard-54be.1)。
 */
const DEFAULT_CANCELLING_GRACE_MS = 5_000;

const STUCK_CANCELLING_ERROR =
  'cancelled: process did not exit within the cancel grace period';

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

interface InternalRunRecord {
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

interface RunCompletionDeferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface InternalRunEntry {
  record: InternalRunRecord;
  logChunks: string[];
  logBytes: number;
  abortController: AbortController;
  completionDeferred: RunCompletionDeferred;
}

function createCompletionDeferred(): RunCompletionDeferred {
  let resolved = false;
  let resolveFn!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveFn = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve();
    };
  });
  return {
    promise,
    resolve: resolveFn,
  };
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function trimToMaxBytes(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) {
    return text;
  }

  const bytes = new TextEncoder().encode(text);
  const tail = bytes.slice(bytes.length - maxBytes);

  for (let offset = 0; offset < tail.length; offset += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(tail.slice(offset));
    } catch {
      // skip a broken leading byte from slicing mid-codepoint
    }
  }

  return '';
}

function formatChunk(chunk: { stream: 'stdout' | 'stderr'; text: string }): string {
  return `[${chunk.stream}] ${chunk.text}`;
}

function toPublicRecord(entry: InternalRunEntry): RunStoreRecord {
  return {
    ...entry.record,
    log: entry.logChunks.join(''),
  };
}

function isActiveStatus(status: RunStatus): boolean {
  return status === 'running' || status === 'cancelling';
}

function countRunning(entries: Iterable<InternalRunEntry>): number {
  let count = 0;
  for (const entry of entries) {
    if (isActiveStatus(entry.record.status)) {
      count += 1;
    }
  }
  return count;
}

function isRunningForTicket(
  entries: Iterable<InternalRunEntry>,
  ticketId: TicketId,
): boolean {
  for (const entry of entries) {
    if (entry.record.ticketId === ticketId && isActiveStatus(entry.record.status)) {
      return true;
    }
  }
  return false;
}

function evictOldestFinished(
  map: Map<string, InternalRunEntry>,
  maxRetainedRuns: number,
): void {
  if (map.size <= maxRetainedRuns) {
    return;
  }

  const finished = [...map.values()]
    .filter((entry) => !isActiveStatus(entry.record.status))
    .sort((a, b) => {
      const aTime = (a.record.finishedAt ?? a.record.startedAt).getTime();
      const bTime = (b.record.finishedAt ?? b.record.startedAt).getTime();
      return aTime - bTime;
    });

  while (map.size > maxRetainedRuns && finished.length > 0) {
    const oldest = finished.shift();
    if (oldest !== undefined) {
      map.delete(oldest.record.id);
    }
  }
}

export function createRunStore(options?: RunStoreOptions): RunStore {
  const maxConcurrent = options?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxRetainedRuns = options?.maxRetainedRuns ?? DEFAULT_MAX_RETAINED_RUNS;
  const maxLogBytes = options?.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  const cancellingGraceMs =
    options?.cancellingGraceMs ?? DEFAULT_CANCELLING_GRACE_MS;
  const now = options?.now ?? (() => new Date());

  const entries = new Map<string, InternalRunEntry>();

  const resolveCompletion = (entry: InternalRunEntry): void => {
    entry.completionDeferred.resolve();
  };

  const markCancelling = (entry: InternalRunEntry): void => {
    entry.abortController.abort();
    entry.record = {
      ...entry.record,
      status: 'cancelling',
      cancellingAt: entry.record.cancellingAt ?? now(),
    };
  };

  const forceCancelStuck = (entry: InternalRunEntry): void => {
    entry.record.status = 'cancelled';
    entry.record.finishedAt = now();
    entry.record.error = STUCK_CANCELLING_ERROR;
    resolveCompletion(entry);
    evictOldestFinished(entries, maxRetainedRuns);
  };

  /**
   * cancelling で finish が来ずに居座る run を猶予経過後に cancelled へ確定する。
   * スロット判定に関わる読み取り経路から遅延評価で掃除する。常駐タイマーは
   * テストを fake timer 依存にするだけで得がない (bdboard-54be.1)。
   */
  const sweepStuckCancelling = (): void => {
    const current = now();
    for (const entry of entries.values()) {
      if (entry.record.status !== 'cancelling') {
        continue;
      }
      const cancellingAt = entry.record.cancellingAt;
      if (cancellingAt === undefined) {
        continue;
      }
      if (current.getTime() - cancellingAt.getTime() >= cancellingGraceMs) {
        forceCancelStuck(entry);
      }
    }
  };

  const cancelAllActive = (): readonly RunStoreRecord[] => {
    const cancelled: RunStoreRecord[] = [];
    for (const entry of entries.values()) {
      if (!isActiveStatus(entry.record.status)) {
        continue;
      }
      markCancelling(entry);
      cancelled.push(toPublicRecord(entry));
    }
    return cancelled;
  };

  return {
    canStart(ticketId) {
      sweepStuckCancelling();

      if (isRunningForTicket(entries.values(), ticketId)) {
        return { ok: false, reason: 'already-running' };
      }

      if (countRunning(entries.values()) >= maxConcurrent) {
        return { ok: false, reason: 'too-many-runs' };
      }

      return { ok: true };
    },

    start(entry) {
      const startedAt = entry.startedAt ?? now();
      const abortController = new AbortController();
      const completionDeferred = createCompletionDeferred();

      const record: InternalRunRecord = {
        id: entry.id,
        ticketId: entry.ticketId,
        runner: entry.runner,
        mode: entry.mode,
        cwd: entry.cwd ?? '',
        status: 'running',
        startedAt,
        sessionId: entry.sessionId,
      };

      entries.set(entry.id, {
        record,
        logChunks: [],
        logBytes: 0,
        abortController,
        completionDeferred,
      });
      evictOldestFinished(entries, maxRetainedRuns);

      return toPublicRecord(entries.get(entry.id)!);
    },

    updateCwd(runId, cwd) {
      const entry = entries.get(runId);
      if (entry === undefined) {
        return undefined;
      }

      entry.record.cwd = cwd;
      return toPublicRecord(entry);
    },

    appendChunk(runId, chunk) {
      const entry = entries.get(runId);
      if (entry === undefined) {
        return undefined;
      }

      let chunkText = formatChunk(chunk);
      let chunkBytes = utf8ByteLength(chunkText);

      if (chunkBytes > maxLogBytes) {
        chunkText = trimToMaxBytes(chunkText, maxLogBytes);
        chunkBytes = utf8ByteLength(chunkText);
        entry.logChunks = [chunkText];
        entry.logBytes = chunkBytes;
      } else {
        entry.logChunks.push(chunkText);
        entry.logBytes += chunkBytes;

        while (entry.logBytes > maxLogBytes && entry.logChunks.length > 0) {
          const removed = entry.logChunks.shift();
          if (removed === undefined) {
            break;
          }
          entry.logBytes -= utf8ByteLength(removed);
        }
      }

      return toPublicRecord(entry);
    },

    finish(runId, outcome) {
      const entry = entries.get(runId);
      if (entry === undefined) {
        return undefined;
      }

      const finishedAt = outcome.run.finishedAt ?? now();
      const preserveCancelled =
        entry.record.status === 'cancelled' || entry.record.status === 'cancelling';

      entry.record.status = preserveCancelled ? 'cancelled' : outcome.run.status;
      entry.record.finishedAt = finishedAt;
      entry.record.exitCode = outcome.run.exitCode;
      entry.record.error = outcome.error ?? outcome.run.error;

      resolveCompletion(entry);
      evictOldestFinished(entries, maxRetainedRuns);

      return toPublicRecord(entry);
    },

    cancel(runId) {
      const entry = entries.get(runId);
      if (entry === undefined) {
        return undefined;
      }

      markCancelling(entry);

      return toPublicRecord(entry);
    },

    cancelAll() {
      sweepStuckCancelling();
      return cancelAllActive();
    },

    async cancelAllAndWait(timeoutMs) {
      sweepStuckCancelling();

      /**
       * agent-run-routes.ts の POST /api/runs は canStart → 同期 start() → await provision()
       * という TOCTOU 対策のために await の位置が固定されており、dispatch Promise を
       * store へ渡す配線を足すとその区間に手を入れることになる。run の完了は必ず
       * finish()（または m-4 の強制 cancelled 化）を通るので、store 側で deferred を
       * 持てば route を触らずに同じことができる (bdboard-54be.1)。
       */
      const completionPromises: Promise<void>[] = [];
      for (const entry of entries.values()) {
        if (isActiveStatus(entry.record.status)) {
          completionPromises.push(entry.completionDeferred.promise);
        }
      }

      cancelAllActive();

      if (completionPromises.length === 0) {
        return;
      }

      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(completionPromises),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },

    get(runId) {
      sweepStuckCancelling();
      const entry = entries.get(runId);
      return entry === undefined ? undefined : toPublicRecord(entry);
    },

    list(filter) {
      sweepStuckCancelling();
      const values = [...entries.values()].map(toPublicRecord);

      if (filter === undefined) {
        return values;
      }

      return values.filter((record) => {
        if (filter.ticketId !== undefined && record.ticketId !== filter.ticketId) {
          return false;
        }
        if (filter.status !== undefined && record.status !== filter.status) {
          return false;
        }
        return true;
      });
    },

    getAbortSignal(runId) {
      return entries.get(runId)?.abortController.signal;
    },
  };
}
