import type Database from 'better-sqlite3';
import type { BoardCache, SessionLinkRow } from '../../../application/ports/board-cache.js';
import type { InteractionRecord } from '../../../domain/interaction.js';
import { MAX_TRANSCRIPT_SESSION_LINKS } from '../../../domain/session.js';

/**
 * interactions の保持上限。双子の {@link MAX_TRANSCRIPT_SESSION_LINKS} と違って
 * 非公開のままだったせいで、キャップの回帰テストがマジックナンバーを書かないと
 * 書けず、結果として書かれていなかった (bdboard-80r)。
 */
export const MAX_INTERACTIONS = 5000;

// BoardCache (アプリ層のポート) の一部を実装する。read.ts と同じ理由で Pick を使う
// (BoardCacheReadOperations のコメント参照)。
export type BoardCacheLinksWriteOperations = Pick<
  BoardCache,
  'upsertSessionLinks' | 'appendInteractions'
>;

export function createLinksWriteOperations(
  db: Database.Database,
): BoardCacheLinksWriteOperations {
  const upsertSessionLinkStmt = db.prepare(`
    INSERT INTO session_links (
      ticket_id, session_id, project_id, source, confidence, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticket_id, session_id) DO UPDATE SET
      project_id = excluded.project_id,
      source = excluded.source,
      confidence = excluded.confidence,
      observed_at = excluded.observed_at
  `);
  const countSessionLinksStmt = db.prepare(`SELECT COUNT(*) AS count FROM session_links`);
  const trimOldestSessionLinksStmt = db.prepare(`
    DELETE FROM session_links
    WHERE rowid IN (
      SELECT rowid FROM session_links
      ORDER BY observed_at ASC
      LIMIT ?
    )
  `);
  const insertInteractionStmt = db.prepare(`
    INSERT OR IGNORE INTO interactions (
      id, at, actor, ticket_id, field, old_value, new_value, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const countInteractionsStmt = db.prepare(`SELECT COUNT(*) AS count FROM interactions`);
  const trimOldestInteractionsStmt = db.prepare(`
    DELETE FROM interactions
    WHERE rowid IN (
      SELECT rowid FROM interactions
      ORDER BY at ASC
      LIMIT ?
    )
  `);

  const trimSessionLinksToCap = (): void => {
    const { count } = countSessionLinksStmt.get() as { readonly count: number };
    if (count <= MAX_TRANSCRIPT_SESSION_LINKS) {
      return;
    }
    trimOldestSessionLinksStmt.run(count - MAX_TRANSCRIPT_SESSION_LINKS);
  };

  const trimInteractionsToCap = (): void => {
    const { count } = countInteractionsStmt.get() as { readonly count: number };
    if (count <= MAX_INTERACTIONS) {
      return;
    }
    trimOldestInteractionsStmt.run(count - MAX_INTERACTIONS);
  };

  return {
    upsertSessionLinks(rows: readonly SessionLinkRow[]): void {
      if (rows.length === 0) {
        return;
      }

      const writeMany = db.transaction((entries: readonly SessionLinkRow[]) => {
        for (const row of entries) {
          upsertSessionLinkStmt.run(
            row.link.ticketId,
            row.link.sessionId,
            row.projectId,
            row.link.source,
            row.link.confidence,
            row.link.observedAt.toISOString(),
          );
        }
        trimSessionLinksToCap();
      });
      writeMany(rows);
    },

    appendInteractions(records: readonly InteractionRecord[]): void {
      if (records.length === 0) {
        return;
      }

      const writeMany = db.transaction((entries: readonly InteractionRecord[]) => {
        for (const record of entries) {
          insertInteractionStmt.run(
            record.id,
            record.at.toISOString(),
            record.actor,
            record.ticketId,
            record.field,
            record.oldValue ?? null,
            record.newValue ?? null,
            record.reason ?? null,
          );
        }
        trimInteractionsToCap();
      });
      writeMany(records);
    },
  };
}
