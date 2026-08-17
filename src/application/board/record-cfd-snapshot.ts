import type { BoardCache } from '../ports/board-cache.js';
import type { Status } from '../../domain/status.js';

export interface RecordCfdSnapshotResult {
  readonly recorded: boolean;
  readonly snapshotDate: string;
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function countTicketsByStatus(
  tickets: readonly { status: Status }[],
): ReadonlyMap<Status, number> {
  const counts = new Map<Status, number>();

  for (const ticket of tickets) {
    counts.set(ticket.status, (counts.get(ticket.status) ?? 0) + 1);
  }

  return counts;
}

export function recordCfdSnapshot(
  cache: BoardCache,
  now: Date,
): RecordCfdSnapshotResult {
  const snapshotDate = formatLocalDate(now);
  const latestDate = cache.getLatestCfdSnapshotDate();

  if (latestDate === snapshotDate) {
    return { recorded: false, snapshotDate };
  }

  const rows: { projectId: string; status: string; count: number }[] = [];

  for (const entry of cache.listProjects()) {
    const counts = countTicketsByStatus(entry.tickets);
    for (const [status, count] of counts) {
      rows.push({
        projectId: entry.project.id,
        status,
        count,
      });
    }
  }

  cache.putCfdSnapshot(snapshotDate, now, rows);
  return { recorded: true, snapshotDate };
}

export interface PruneCfdSnapshotsResult {
  readonly deletedCount: number;
  readonly cutoffDate: string;
}

export function pruneOldCfdSnapshots(
  cache: BoardCache,
  now: Date,
  retentionDays: number,
): PruneCfdSnapshotsResult {
  if (retentionDays <= 0) {
    return { deletedCount: 0, cutoffDate: formatLocalDate(now) };
  }

  const cutoffDate = formatLocalDate(
    new Date(now.getTime() - retentionDays * 86_400_000),
  );
  const deletedCount = cache.pruneCfdSnapshots(cutoffDate);
  return { deletedCount, cutoffDate };
}
