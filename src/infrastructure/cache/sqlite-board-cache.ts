import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  BoardCache,
  CachedProject,
  CacheStats,
  CfdSnapshotRow,
  SessionLinkRow,
} from '../../application/ports/board-cache.js';
import type { PendingDecision } from '../../application/ports/human-decisions.js';
import type { ModelUsageTotals } from '../../application/transcript/extract-usage.js';
import type { InteractionRecord } from '../../domain/interaction.js';
import type { Project } from '../../domain/project.js';
import { MAX_TRANSCRIPT_SESSION_LINKS, type SessionLinkSource } from '../../domain/session.js';
import { deserializeTickets, serializeTickets } from './ticket-serialization.js';

const SCHEMA_VERSION = '6';

const CACHE_TABLE_NAMES = [
  'projects',
  'transcript_offsets',
  'session_usage',
  'meta',
  'cfd_snapshots',
  'session_links',
  'chat_sessions',
  'chat_messages',
  'interactions',
] as const;

const MAX_INTERACTIONS = 5000;

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly root_path: string;
  readonly prefixes: string;
  readonly alias_paths?: string | null;
  readonly fingerprint: string;
  readonly fetched_at: string;
  readonly tickets: string;
  readonly pending_decisions?: string | null;
}

interface TranscriptOffsetRow {
  readonly file_path: string;
  readonly byte_offset: number;
}

interface SessionUsageRow {
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
}

interface MetaRow {
  readonly value: string;
}

interface SessionLinkRowDb {
  readonly ticket_id: string;
  readonly session_id: string;
  readonly project_id: string;
  readonly source: string;
  readonly confidence: number;
  readonly observed_at: string;
}

interface CfdSnapshotRowDb {
  readonly project_id: string;
  readonly status: string;
  readonly snapshot_date: string;
  readonly snapshotted_at: string;
  readonly count: number;
}

interface InteractionRowDb {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly ticket_id: string;
  readonly field: string;
  readonly old_value: string | null;
  readonly new_value: string | null;
  readonly reason: string | null;
}

interface SqliteMasterRow {
  readonly name: string;
}

interface TableInfoRow {
  readonly name: string;
}

function parseAliasPaths(raw: string | null | undefined): readonly string[] {
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function parsePendingDecisions(
  raw: string | null | undefined,
): readonly PendingDecision[] | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const decisions: PendingDecision[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }

      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string') {
        continue;
      }

      const decision: PendingDecision = {
        id: record.id,
        allowFreeform: record.allowFreeform === true,
        ...(typeof record.question === 'string' ? { question: record.question } : {}),
        ...(Array.isArray(record.options)
          ? {
              options: record.options
                .filter(
                  (option): option is { label: string; value: string } =>
                    typeof option === 'object' &&
                    option !== null &&
                    typeof (option as Record<string, unknown>).label === 'string' &&
                    typeof (option as Record<string, unknown>).value === 'string',
                )
                .map((option) => ({
                  label: option.label,
                  value: option.value,
                })),
            }
          : {}),
      };
      decisions.push(decision);
    }

    return decisions.length > 0 ? decisions : undefined;
  } catch {
    return undefined;
  }
}

function rowToCachedProject(row: ProjectRow): CachedProject {
  const project: Project = {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    prefixes: JSON.parse(row.prefixes) as readonly string[],
    aliasPaths: parseAliasPaths(row.alias_paths),
  };

  const pendingDecisions = parsePendingDecisions(row.pending_decisions);

  return {
    project,
    tickets: deserializeTickets(row.tickets),
    fingerprint: row.fingerprint,
    fetchedAt: new Date(row.fetched_at),
    ...(pendingDecisions !== undefined ? { pendingDecisions } : {}),
  };
}

function needsSchemaRecreate(db: Database.Database): boolean {
  const tableRow = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
    .get() as SqliteMasterRow | undefined;

  if (tableRow === undefined) {
    return false;
  }

  const versionRow = db
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as MetaRow | undefined;

  if (versionRow === undefined) {
    return false;
  }

  if (versionRow.value === SCHEMA_VERSION) {
    return false;
  }

  // v1/v2/v3/v4/v5 databases gain missing tables (session_usage, cfd_snapshots,
  // session_links, chat_sessions, chat_messages) in place; recreate is never
  // needed to reach v6 from v1, v2, v3, v4, or v5.
  //
  // IMPORTANT: if SCHEMA_VERSION is bumped again, add the *previous* version to
  // this list only after confirming the new table(s) can be added via
  // `CREATE TABLE IF NOT EXISTS` without touching existing tables. Forgetting to
  // add a version here makes existing installs recreate the whole schema on next
  // startup, silently destroying `projects` and (irrecoverable) `cfd_snapshots`.
  if (
    versionRow.value === '1' ||
    versionRow.value === '2' ||
    versionRow.value === '3' ||
    versionRow.value === '4' ||
    versionRow.value === '5'
  ) {
    return false;
  }

  return true;
}

function ensureAliasPathsColumn(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(projects)`).all() as TableInfoRow[];
  const hasAliasPaths = columns.some((column) => column.name === 'alias_paths');
  if (!hasAliasPaths) {
    db.exec(`ALTER TABLE projects ADD COLUMN alias_paths TEXT`);
  }
}

function ensurePendingDecisionsColumn(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(projects)`).all() as TableInfoRow[];
  const hasPendingDecisions = columns.some((column) => column.name === 'pending_decisions');
  if (!hasPendingDecisions) {
    db.exec(`ALTER TABLE projects ADD COLUMN pending_decisions TEXT`);
  }
}

function ensureChatSessionsAgentIdColumn(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(chat_sessions)`)
    .all() as TableInfoRow[];
  if (!columns.some((column) => column.name === 'agent_id')) {
    // agent_id 列を持たない時代 (bdboard-l1t.2 以前) に作られた行は、当時
    // 唯一のエージェントだった claude が発行したもの。DEFAULT で埋めることで
    // 再起動後も既存セッションの resume が壊れない。
    db.exec(
      `ALTER TABLE chat_sessions ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'claude'`,
    );
  }
}

function ensureChatSessionsModelColumn(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(chat_sessions)`)
    .all() as TableInfoRow[];
  if (!columns.some((column) => column.name === 'model')) {
    db.exec(`ALTER TABLE chat_sessions ADD COLUMN model TEXT`);
  }
}

function ensureChatSessionsTitleColumn(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(chat_sessions)`)
    .all() as TableInfoRow[];
  if (!columns.some((column) => column.name === 'title')) {
    db.exec(`ALTER TABLE chat_sessions ADD COLUMN title TEXT`);
  }
}

function ensureChatSessionsPinnedColumn(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(chat_sessions)`)
    .all() as TableInfoRow[];
  if (!columns.some((column) => column.name === 'pinned')) {
    db.exec(`ALTER TABLE chat_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }
}

function ensureChatMessagesFailedToolsColumn(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(chat_messages)`)
    .all() as TableInfoRow[];
  if (!columns.some((column) => column.name === 'failed_tools')) {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN failed_tools TEXT`);
  }
}

function ensureChatMessagesAgentWarningsColumn(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(chat_messages)`)
    .all() as TableInfoRow[];
  if (!columns.some((column) => column.name === 'agent_warnings')) {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN agent_warnings TEXT`);
  }
}

function initializeSchema(db: Database.Database, recreate: boolean): void {
  if (recreate) {
    // cfd_snapshots / chat_sessions / chat_messages は意図的に対象外: いずれも
    // 再構築不能なデータ (cfd_snapshots=過去の時系列スナップショット、
    // chat_sessions=このチャット機能が実際に発行した既知セッションID台帳、
    // chat_messages=永続化された会話履歴) なので、他のテーブルを作り直す
    // (=schema_version 不一致からの復旧) 経路でも巻き添えで消さない。
    db.exec(`
      DROP TABLE IF EXISTS projects;
      DROP TABLE IF EXISTS transcript_offsets;
      DROP TABLE IF EXISTS session_usage;
      DROP TABLE IF EXISTS session_links;
      DROP TABLE IF EXISTS meta;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      prefixes TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      tickets TEXT NOT NULL,
      alias_paths TEXT,
      pending_decisions TEXT
    );
    CREATE TABLE IF NOT EXISTS transcript_offsets (
      file_path TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_usage (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, model)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cfd_snapshots (
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      snapshotted_at TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (project_id, status, snapshot_date)
    );
    CREATE TABLE IF NOT EXISTS session_links (
      ticket_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (ticket_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS chat_sessions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'claude',
      model TEXT,
      title TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      failed_tools TEXT,
      agent_warnings TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, created_at);
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_interactions_at ON interactions (at);
  `);

  ensureAliasPathsColumn(db);
  ensurePendingDecisionsColumn(db);
  // agent_id 列追加は in-place 移行 (既存 chat_sessions 行を壊さない) なので
  // SCHEMA_VERSION を上げない — recreate 判定ロジックへの手当ては不要。
  ensureChatSessionsAgentIdColumn(db);
  // model 列追加は in-place 移行なので SCHEMA_VERSION を上げない。
  ensureChatSessionsModelColumn(db);
  // title / pinned 列追加は in-place 移行なので SCHEMA_VERSION を上げない。
  ensureChatSessionsTitleColumn(db);
  ensureChatSessionsPinnedColumn(db);
  // failed_tools 列追加は in-place 移行なので SCHEMA_VERSION を上げない。
  ensureChatMessagesFailedToolsColumn(db);
  // agent_warnings 列追加は in-place 移行なので SCHEMA_VERSION を上げない。
  ensureChatMessagesAgentWarningsColumn(db);

  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(
    'schema_version',
    SCHEMA_VERSION,
  );
}

/**
 * cache.db を開き、必要なら schema を初期化/移行してから生の better-sqlite3 接続を返す。
 *
 * createSqliteBoardCache に加え、同じ cache.db ファイルを別の接続から扱いたい実装
 * (例: infrastructure/chat/sqlite-chat-session-repository.ts) から再利用する。
 * schema の初期化/移行ロジックの正本はこの1箇所のみに保つのが目的 — 複数箇所で
 * SCHEMA_VERSION の判定やテーブル定義を重複させない。
 */
export function openCacheDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const recreate = needsSchemaRecreate(db);
  initializeSchema(db, recreate);

  return db;
}

export function createSqliteBoardCache(dbPath: string): BoardCache {
  const db = openCacheDatabase(dbPath);

  const getProjectStmt = db.prepare(`SELECT * FROM projects WHERE id = ?`);
  const putProjectStmt = db.prepare(`
    INSERT OR REPLACE INTO projects (
      id, name, root_path, prefixes, fingerprint, fetched_at, tickets, alias_paths, pending_decisions
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listProjectsStmt = db.prepare(`SELECT * FROM projects ORDER BY root_path ASC`);
  const deleteProjectStmt = db.prepare(`DELETE FROM projects WHERE id = ?`);
  const getTranscriptOffsetStmt = db.prepare(
    `SELECT byte_offset FROM transcript_offsets WHERE file_path = ?`,
  );
  const setTranscriptOffsetStmt = db.prepare(`
    INSERT OR REPLACE INTO transcript_offsets (file_path, byte_offset, updated_at)
    VALUES (?, ?, ?)
  `);
  const addSessionUsageStmt = db.prepare(`
    INSERT INTO session_usage (
      session_id,
      model,
      input_tokens,
      output_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, model) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_creation_input_tokens = cache_creation_input_tokens + excluded.cache_creation_input_tokens,
      cache_read_input_tokens = cache_read_input_tokens + excluded.cache_read_input_tokens
  `);
  const putCfdSnapshotStmt = db.prepare(`
    INSERT OR REPLACE INTO cfd_snapshots (
      project_id, status, snapshot_date, snapshotted_at, count
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const listCfdSnapshotsAllStmt = db.prepare(`
    SELECT project_id, status, snapshot_date, snapshotted_at, count
    FROM cfd_snapshots
    ORDER BY snapshot_date ASC, project_id ASC, status ASC
  `);
  const getLatestCfdSnapshotDateStmt = db.prepare(`
    SELECT MAX(snapshot_date) AS snapshot_date FROM cfd_snapshots
  `);
  const pruneCfdSnapshotsStmt = db.prepare(`
    DELETE FROM cfd_snapshots WHERE snapshot_date < ?
  `);
  const countTableRowsStmts = Object.fromEntries(
    CACHE_TABLE_NAMES.map((tableName) => [
      tableName,
      db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`),
    ]),
  ) as Record<(typeof CACHE_TABLE_NAMES)[number], Database.Statement>;
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
  const listSessionLinksStmt = db.prepare(`
    SELECT ticket_id, session_id, project_id, source, confidence, observed_at
    FROM session_links
    ORDER BY ticket_id ASC, session_id ASC
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
  const listInteractionsAllStmt = db.prepare(`
    SELECT id, at, actor, ticket_id, field, old_value, new_value, reason
    FROM interactions
    ORDER BY at DESC, id ASC
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

  const rowToSessionLink = (row: SessionLinkRowDb): SessionLinkRow => ({
    projectId: row.project_id,
    link: {
      ticketId: row.ticket_id,
      sessionId: row.session_id,
      source: row.source as SessionLinkSource,
      confidence: row.confidence,
      observedAt: new Date(row.observed_at),
    },
  });

  const trimSessionLinksToCap = (): void => {
    const { count } = countSessionLinksStmt.get() as { readonly count: number };
    if (count <= MAX_TRANSCRIPT_SESSION_LINKS) {
      return;
    }
    trimOldestSessionLinksStmt.run(count - MAX_TRANSCRIPT_SESSION_LINKS);
  };

  const rowToCfdSnapshot = (row: CfdSnapshotRowDb): CfdSnapshotRow => ({
    projectId: row.project_id,
    status: row.status,
    snapshotDate: row.snapshot_date,
    snapshottedAt: new Date(row.snapshotted_at),
    count: row.count,
  });

  const rowToInteraction = (row: InteractionRowDb): InteractionRecord => ({
    id: row.id,
    at: new Date(row.at),
    actor: row.actor,
    ticketId: row.ticket_id,
    field: row.field,
    ...(row.old_value !== null ? { oldValue: row.old_value } : {}),
    ...(row.new_value !== null ? { newValue: row.new_value } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
  });

  const trimInteractionsToCap = (): void => {
    const { count } = countInteractionsStmt.get() as { readonly count: number };
    if (count <= MAX_INTERACTIONS) {
      return;
    }
    trimOldestInteractionsStmt.run(count - MAX_INTERACTIONS);
  };

  return {
    getProject(projectId: string): CachedProject | undefined {
      const row = getProjectStmt.get(projectId) as ProjectRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      return rowToCachedProject(row);
    },

    putProject(entry: CachedProject): void {
      putProjectStmt.run(
        entry.project.id,
        entry.project.name,
        entry.project.rootPath,
        JSON.stringify(entry.project.prefixes),
        entry.fingerprint,
        entry.fetchedAt.toISOString(),
        serializeTickets(entry.tickets),
        JSON.stringify(entry.project.aliasPaths),
        entry.pendingDecisions !== undefined
          ? JSON.stringify(entry.pendingDecisions)
          : null,
      );
    },

    listProjects(): readonly CachedProject[] {
      const rows = listProjectsStmt.all() as ProjectRow[];
      return rows.map(rowToCachedProject);
    },

    deleteProject(projectId: string): void {
      deleteProjectStmt.run(projectId);
    },

    clear(): void {
      // cfd_snapshots / chat_sessions / chat_messages は意図的に除外:
      // - cfd_snapshots: 削除すると再構築不能な唯一の時系列データ。
      // - chat_sessions: session_usage/session_links と違い、bd/transcript の再スキャンで
      //   復元できるデータではない (このチャット機能が実際に発行したセッションIDだけを
      //   記憶する security 目的の台帳)。再スキャンで復元してしまうと「このアプリ経由で
      //   始めたセッションのみ resume を許す」という isKnown() の検証意図が崩れるため、
      //   clear() で一律に消してよい対象ではない。
      // - chat_messages: 会話本文は bd/transcript から復元できない。
      // 他のテーブルは元データ(bd/transcript)から再構築可能。
      db.exec(
        `DELETE FROM projects; DELETE FROM transcript_offsets; DELETE FROM session_usage; DELETE FROM session_links; DELETE FROM interactions;`,
      );
    },

    getTranscriptOffset(filePath: string): number | undefined {
      const row = getTranscriptOffsetStmt.get(filePath) as TranscriptOffsetRow | undefined;
      return row?.byte_offset;
    },

    setTranscriptOffset(filePath: string, offset: number): void {
      setTranscriptOffsetStmt.run(filePath, offset, new Date().toISOString());
    },

    addSessionUsage(sessionId: string, usage: ModelUsageTotals): void {
      addSessionUsageStmt.run(
        sessionId,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationInputTokens,
        usage.cacheReadInputTokens,
      );
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

    putCfdSnapshot(
      snapshotDate: string,
      snapshottedAt: Date,
      rows: readonly { projectId: string; status: string; count: number }[],
    ): void {
      const snapshottedAtIso = snapshottedAt.toISOString();
      const writeMany = db.transaction(
        (entries: readonly { projectId: string; status: string; count: number }[]) => {
          for (const row of entries) {
            putCfdSnapshotStmt.run(
              row.projectId,
              row.status,
              snapshotDate,
              snapshottedAtIso,
              row.count,
            );
          }
        },
      );
      writeMany(rows);
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

    pruneCfdSnapshots(olderThanDate: string): number {
      const result = pruneCfdSnapshotsStmt.run(olderThanDate);
      return result.changes;
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

    listSessionLinks(): readonly SessionLinkRow[] {
      const rows = listSessionLinksStmt.all() as SessionLinkRowDb[];
      return rows.map(rowToSessionLink);
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

    close(): void {
      db.close();
    },
  };
}
