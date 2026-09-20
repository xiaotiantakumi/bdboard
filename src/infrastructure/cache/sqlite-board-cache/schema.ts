import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MetaRow, SqliteMasterRow } from './row-types.js';
import {
  ensureAliasPathsColumn,
  ensureChatMessagesAgentWarningsColumn,
  ensureChatMessagesFailedToolsColumn,
  ensureChatSessionsAgentIdColumn,
  ensureChatSessionsModelColumn,
  ensureChatSessionsPinnedColumn,
  ensureChatSessionsTitleColumn,
  ensurePendingDecisionsColumn,
} from './schema-migrations.js';

const SCHEMA_VERSION = '6';

export const CACHE_TABLE_NAMES = [
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
