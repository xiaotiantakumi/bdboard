import {
  cancelAllActive,
  markCancelling,
  resolveCompletion,
  sweepStuckCancelling,
} from './cancellation.js';
import { createCompletionDeferred } from './completion-deferred.js';
import {
  DEFAULT_CANCELLING_GRACE_MS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_MAX_RETAINED_RUNS,
} from './constants.js';
import { formatChunk, trimToMaxBytes, utf8ByteLength } from './log-buffer.js';
import { countRunning, evictOldestFinished, isActiveStatus, isRunningForTicket, toPublicRecord } from './record-helpers.js';
import type { InternalRunEntry, InternalRunRecord, RunStore, RunStoreOptions } from './types.js';

export function createRunStore(options?: RunStoreOptions): RunStore {
  const maxConcurrent = options?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxRetainedRuns = options?.maxRetainedRuns ?? DEFAULT_MAX_RETAINED_RUNS;
  const maxLogBytes = options?.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  const cancellingGraceMs =
    options?.cancellingGraceMs ?? DEFAULT_CANCELLING_GRACE_MS;
  const now = options?.now ?? (() => new Date());

  const entries = new Map<string, InternalRunEntry>();

  const sweep = (): void => {
    sweepStuckCancelling(entries, now, cancellingGraceMs, maxRetainedRuns);
  };

  return {
    canStart(ticketId) {
      sweep();

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

      markCancelling(entry, now);

      return toPublicRecord(entry);
    },

    cancelAll() {
      sweep();
      return cancelAllActive(entries, now);
    },

    async cancelAllAndWait(timeoutMs) {
      sweep();

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

      cancelAllActive(entries, now);

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
      sweep();
      const entry = entries.get(runId);
      return entry === undefined ? undefined : toPublicRecord(entry);
    },

    list(filter) {
      sweep();
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
