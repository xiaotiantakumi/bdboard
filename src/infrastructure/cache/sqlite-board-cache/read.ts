import type Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import type {
  CachedProject,
  CacheStats,
  CfdSnapshotRow,
  SessionLinkRow,
} from '../../../application/ports/board-cache.js';
import type { ModelUsageTotals } from '../../../application/transcript/extract-usage.js';
import type { InteractionRecord } from '../../../domain/interaction.js';
import { CACHE_TABLE_NAMES } from './schema.js';
import { rowToCachedProject, rowToCfdSnapshot, rowToInteraction, rowToSessionLink } from './convert.js';
import type {
  CfdSnapshotRowDb,
  InteractionRowDb,
  ProjectRow,
  SessionLinkRowDb,
  SessionUsageRow,
  TranscriptOffsetRow,
} from './row-types.js';

export interface BoardCacheReadOperations {
  getProject(projectId: string): CachedProject | undefined;
  listProjects(): readonly CachedProject[];
  getTranscriptOffset(filePath: string): number | undefined;
  getSessionUsage(sessionIds: readonly string[]): readonly ModelUsageTotals[];
  listCfdSnapshots(projectIds?: readonly string[]): readonly CfdSnapshotRow[];
  getLatestCfdSnapshotDate(): string | undefined;
  getCacheStats(): CacheStats;
  listSessionLinks(): readonly SessionLinkRow[];
  listInteractions(options?: { readonly since?: Date }): readonly InteractionRecord[];
}

export function createReadOperations(
  db: Database.Database,
  dbPath: string,
): BoardCacheReadOperations {
  const getProjectStmt = db.prepare(`SELECT * FROM projects WHERE id = ?`);
  const listProjectsStmt = db.prepare(`SELECT * FROM projects ORDER BY root_path ASC`);
  const getTranscriptOffsetStmt = db.prepare(
    `SELECT byte_offset FROM transcript_offsets WHERE file_path = ?`,
  );
  const listCfdSnapshotsAllStmt = db.prepare(`
    SELECT project_id, status, snapshot_date, snapshotted_at, count
    FROM cfd_snapshots
    ORDER BY snapshot_date ASC, project_id ASC, status ASC
  `);
  const getLatestCfdSnapshotDateStmt = db.prepare(`
    SELECT MAX(snapshot_date) AS snapshot_date FROM cfd_snapshots
  `);
  const countTableRowsStmts = Object.fromEntries(
    CACHE_TABLE_NAMES.map((tableName) => [
      tableName,
      db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`),
    ]),
  ) as Record<(typeof CACHE_TABLE_NAMES)[number], Database.Statement>;
  const listSessionLinksStmt = db.prepare(`
    SELECT ticket_id, session_id, project_id, source, confidence, observed_at
    FROM session_links
    ORDER BY ticket_id ASC, session_id ASC
  `);
  const listInteractionsAllStmt = db.prepare(`
    SELECT id, at, actor, ticket_id, field, old_value, new_value, reason
    FROM interactions
    ORDER BY at DESC, id ASC
  `);

  return {
    getProject(projectId: string): CachedProject | undefined {
      const row = getProjectStmt.get(projectId) as ProjectRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      const entry = rowToCachedProject(row);
      return entry ?? undefined;
    },

    listProjects(): readonly CachedProject[] {
      const rows = listProjectsStmt.all() as ProjectRow[];
      return rows
        .map(rowToCachedProject)
        .filter((entry): entry is CachedProject => entry !== null);
    },

    getTranscriptOffset(filePath: string): number | undefined {
      const row = getTranscriptOffsetStmt.get(filePath) as TranscriptOffsetRow | undefined;
      return row?.byte_offset;
    },

    getSessionUsage(sessionIds: readonly string[]): readonly ModelUsageTotals[] {
      if (sessionIds.length === 0) {
        return [];
      }

      const placeholders = sessionIds.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT
            model,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
            SUM(cache_read_input_tokens) AS cache_read_input_tokens
          FROM session_usage
          WHERE session_id IN (${placeholders})
          GROUP BY model
          ORDER BY model ASC`,
        )
        .all(...sessionIds) as SessionUsageRow[];

      return rows.map((row) => ({
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheCreationInputTokens: row.cache_creation_input_tokens,
        cacheReadInputTokens: row.cache_read_input_tokens,
      }));
    },

    listCfdSnapshots(projectIds?: readonly string[]): readonly CfdSnapshotRow[] {
      if (projectIds === undefined) {
        const rows = listCfdSnapshotsAllStmt.all() as CfdSnapshotRowDb[];
        return rows.map(rowToCfdSnapshot);
      }

      if (projectIds.length === 0) {
        return [];
      }

      const placeholders = projectIds.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT project_id, status, snapshot_date, snapshotted_at, count
          FROM cfd_snapshots
          WHERE project_id IN (${placeholders})
          ORDER BY snapshot_date ASC, project_id ASC, status ASC`,
        )
        .all(...projectIds) as CfdSnapshotRowDb[];

      return rows.map(rowToCfdSnapshot);
    },

    getLatestCfdSnapshotDate(): string | undefined {
      const row = getLatestCfdSnapshotDateStmt.get() as
        | { readonly snapshot_date: string | null }
        | undefined;
      if (row?.snapshot_date === undefined || row.snapshot_date === null) {
        return undefined;
      }
      return row.snapshot_date;
    },

    getCacheStats(): CacheStats {
      const sizeBytes =
        dbPath === ':memory:'
          ? 0
          : statSync(dbPath, { throwIfNoEntry: false })?.size ?? 0;
      const tables = CACHE_TABLE_NAMES.map((name) => {
        const row = countTableRowsStmts[name].get() as { readonly count: number };
        return { name, rowCount: row.count };
      });
      return { sizeBytes, tables };
    },

    listSessionLinks(): readonly SessionLinkRow[] {
      const rows = listSessionLinksStmt.all() as SessionLinkRowDb[];
      return rows.map(rowToSessionLink);
    },

    listInteractions(options?: { readonly since?: Date }): readonly InteractionRecord[] {
      const since = options?.since;
      if (since === undefined) {
        const rows = listInteractionsAllStmt.all() as InteractionRowDb[];
        return rows.map(rowToInteraction);
      }

      const sinceIso = since.toISOString();
      const rows = db
        .prepare(
          `SELECT id, at, actor, ticket_id, field, old_value, new_value, reason
          FROM interactions
          WHERE at >= ?
          ORDER BY at DESC, id ASC`,
        )
        .all(sinceIso) as InteractionRowDb[];

      return rows.map(rowToInteraction);
    },
  };
}
