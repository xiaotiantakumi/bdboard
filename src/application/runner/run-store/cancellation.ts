import { STUCK_CANCELLING_ERROR } from './constants.js';
import { evictOldestFinished, isActiveStatus, toPublicRecord } from './record-helpers.js';
import type { InternalRunEntry, RunStoreRecord } from './types.js';

export function resolveCompletion(entry: InternalRunEntry): void {
  entry.completionDeferred.resolve();
}

export function markCancelling(entry: InternalRunEntry, now: () => Date): void {
  entry.abortController.abort();
  entry.record = {
    ...entry.record,
    status: 'cancelling',
    cancellingAt: entry.record.cancellingAt ?? now(),
  };
}

export function forceCancelStuck(
  entry: InternalRunEntry,
  now: () => Date,
  entries: Map<string, InternalRunEntry>,
  maxRetainedRuns: number,
): void {
  entry.record.status = 'cancelled';
  entry.record.finishedAt = now();
  entry.record.error = STUCK_CANCELLING_ERROR;
  resolveCompletion(entry);
  evictOldestFinished(entries, maxRetainedRuns);
}

/**
 * cancelling で finish が来ずに居座る run を猶予経過後に cancelled へ確定する。
 * スロット判定に関わる読み取り経路から遅延評価で掃除する。常駐タイマーは
 * テストを fake timer 依存にするだけで得がない (bdboard-54be.1)。
 */
export function sweepStuckCancelling(
  entries: Map<string, InternalRunEntry>,
  now: () => Date,
  cancellingGraceMs: number,
  maxRetainedRuns: number,
): void {
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
      forceCancelStuck(entry, now, entries, maxRetainedRuns);
    }
  }
}

export function cancelAllActive(
  entries: Map<string, InternalRunEntry>,
  now: () => Date,
): readonly RunStoreRecord[] {
  const cancelled: RunStoreRecord[] = [];
  for (const entry of entries.values()) {
    if (!isActiveStatus(entry.record.status)) {
      continue;
    }
    markCancelling(entry, now);
    cancelled.push(toPublicRecord(entry));
  }
  return cancelled;
}
