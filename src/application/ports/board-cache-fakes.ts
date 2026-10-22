import { compareStrings } from '../../domain/compare.js';
import type { InteractionRecord } from '../../domain/interaction.js';
import type { BoardCache, SessionLinkRow } from './board-cache.js';

/** テスト用: getCacheStats を空の値で満たす */
export function createEmptyCacheStatsMethods(): Pick<BoardCache, 'getCacheStats'> {
  return {
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
