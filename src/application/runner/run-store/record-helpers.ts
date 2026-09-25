import type { RunStatus } from '../../../domain/run.js';
import type { TicketId } from '../../../domain/ticket-id.js';
import type { InternalRunEntry, RunStoreRecord } from './types.js';

export function toPublicRecord(entry: InternalRunEntry): RunStoreRecord {
  return {
    ...entry.record,
    log: entry.logChunks.join(''),
  };
}

// web/src/hooks/useActiveAgentRuns.ts (bdboard-xuuz) がこの条件をクライアント側の
// 文字列比較として複製している (web は src/ を import できないため)。ここを変えたら
// 向こうも揃えること。
export function isActiveStatus(status: RunStatus): boolean {
  return status === 'running' || status === 'cancelling';
}

export function countRunning(entries: Iterable<InternalRunEntry>): number {
  let count = 0;
  for (const entry of entries) {
    if (isActiveStatus(entry.record.status)) {
      count += 1;
    }
  }
  return count;
}

export function isRunningForTicket(
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

export function evictOldestFinished(
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
