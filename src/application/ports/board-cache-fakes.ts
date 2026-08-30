import { compareStrings } from '../../domain/compare.js';
import type { InteractionRecord } from '../../domain/interaction.js';
import type { BoardCache, CfdSnapshotRow, SessionLinkRow } from './board-cache.js';

/** テスト用: CFD メソッドを no-op / 空配列で満たす */
export function createEmptyCfdCacheMethods(): Pick<
  BoardCache,
  | 'putCfdSnapshot'
  | 'listCfdSnapshots'
  | 'getLatestCfdSnapshotDate'
  | 'pruneCfdSnapshots'
  | 'getCacheStats'
> {
  return {
    putCfdSnapshot(): void {},
    listCfdSnapshots(): readonly CfdSnapshotRow[] {
      return [];
    },
    getLatestCfdSnapshotDate(): string | undefined {
      return undefined;
    },
    pruneCfdSnapshots(): number {
      return 0;
    },
    getCacheStats() {
      return { sizeBytes: 0, tables: [] };
    },
  };
}

/** テスト用: メモリ上に CFD スナップショットを保持する */
export function createInMemoryCfdCacheMethods(): Pick<
  BoardCache,
  | 'putCfdSnapshot'
  | 'listCfdSnapshots'
  | 'getLatestCfdSnapshotDate'
  | 'pruneCfdSnapshots'
  | 'getCacheStats'
> & { readonly cfdSnapshots: CfdSnapshotRow[] } {
  const cfdSnapshots: CfdSnapshotRow[] = [];

  return {
    cfdSnapshots,
    putCfdSnapshot(
      snapshotDate: string,
      snapshottedAt: Date,
      rows: readonly { projectId: string; status: string; count: number }[],
    ): void {
      for (const row of rows) {
        const index = cfdSnapshots.findIndex(
          (entry) =>
            entry.projectId === row.projectId &&
            entry.status === row.status &&
            entry.snapshotDate === snapshotDate,
        );
        const next: CfdSnapshotRow = {
          projectId: row.projectId,
          status: row.status,
          snapshotDate,
          snapshottedAt,
          count: row.count,
        };
        if (index >= 0) {
          cfdSnapshots[index] = next;
        } else {
          cfdSnapshots.push(next);
        }
      }
      cfdSnapshots.sort((a, b) => {
        const dateCmp = a.snapshotDate.localeCompare(b.snapshotDate);
        if (dateCmp !== 0) {
          return dateCmp;
        }
        const projectCmp = compareStrings(a.projectId, b.projectId);
        if (projectCmp !== 0) {
          return projectCmp;
        }
        return a.status.localeCompare(b.status);
      });
    },
    listCfdSnapshots(projectIds?: readonly string[]): readonly CfdSnapshotRow[] {
      if (projectIds === undefined) {
        return [...cfdSnapshots];
      }
      const filterSet = new Set(projectIds);
      return cfdSnapshots.filter((entry) => filterSet.has(entry.projectId));
    },
    getLatestCfdSnapshotDate(): string | undefined {
      if (cfdSnapshots.length === 0) {
        return undefined;
      }
      return cfdSnapshots.reduce((latest, entry) =>
        entry.snapshotDate > latest ? entry.snapshotDate : latest,
      cfdSnapshots[0]!.snapshotDate);
    },
    pruneCfdSnapshots(olderThanDate: string): number {
      const before = cfdSnapshots.length;
      for (let index = cfdSnapshots.length - 1; index >= 0; index -= 1) {
        if (cfdSnapshots[index]!.snapshotDate < olderThanDate) {
          cfdSnapshots.splice(index, 1);
        }
      }
      return before - cfdSnapshots.length;
    },
    getCacheStats() {
      return { sizeBytes: 0, tables: [] };
    },
  };
}

/** テスト用: セッションリンク系メソッドを no-op / 空配列で満たす */
export function createEmptySessionLinksCacheMethods(): Pick<
  BoardCache,
  'upsertSessionLinks' | 'listSessionLinks'
> {
  return {
    upsertSessionLinks(): void {},
    listSessionLinks(): readonly SessionLinkRow[] {
      return [];
    },
  };
}

/** テスト用: メモリ上にセッションリンクを保持する((ticketId, sessionId) で一意に upsert) */
export function createInMemorySessionLinksCacheMethods(): Pick<
  BoardCache,
  'upsertSessionLinks' | 'listSessionLinks'
> & { readonly sessionLinks: Map<string, SessionLinkRow> } {
  const sessionLinks = new Map<string, SessionLinkRow>();
  const keyOf = (row: SessionLinkRow): string =>
    `${row.link.ticketId}\0${row.link.sessionId}`;

  return {
    sessionLinks,
    upsertSessionLinks(rows: readonly SessionLinkRow[]): void {
      for (const row of rows) {
        sessionLinks.set(keyOf(row), row);
      }
    },
    listSessionLinks(): readonly SessionLinkRow[] {
      return [...sessionLinks.values()].sort((a, b) => {
        const ticketCmp = compareStrings(a.link.ticketId, b.link.ticketId);
        if (ticketCmp !== 0) {
          return ticketCmp;
        }
        return compareStrings(a.link.sessionId, b.link.sessionId);
      });
    },
  };
}

/** テスト用: interactions メソッドを no-op / 空配列で満たす */
export function createEmptyInteractionsCacheMethods(): Pick<
  BoardCache,
  'appendInteractions' | 'listInteractions'
> {
  return {
    appendInteractions(): void {},
    listInteractions(): readonly InteractionRecord[] {
      return [];
    },
  };
}

/** テスト用: メモリ上に interactions を保持する(id で INSERT OR IGNORE 相当の upsert) */
export function createInMemoryInteractionsCacheMethods(): Pick<
  BoardCache,
  'appendInteractions' | 'listInteractions'
> & { readonly interactions: Map<string, InteractionRecord> } {
  const interactions = new Map<string, InteractionRecord>();

  return {
    interactions,
    appendInteractions(records: readonly InteractionRecord[]): void {
      for (const record of records) {
        if (!interactions.has(record.id)) {
          interactions.set(record.id, record);
        }
      }
    },
    listInteractions(options?: { readonly since?: Date }): readonly InteractionRecord[] {
      const since = options?.since;
      const rows = [...interactions.values()].filter(
        (record) => since === undefined || record.at >= since,
      );
      return rows.sort((a, b) => {
        const atCmp = b.at.getTime() - a.at.getTime();
        if (atCmp !== 0) {
          return atCmp;
        }
        return compareStrings(a.id, b.id);
      });
    },
  };
}
