import type Database from 'better-sqlite3';
import type { TableInfoRow } from './row-types.js';

export function ensureAliasPathsColumn(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(projects)`).all() as TableInfoRow[];
  const hasAliasPaths = columns.some((column) => column.name === 'alias_paths');
  if (!hasAliasPaths) {
    db.exec(`ALTER TABLE projects ADD COLUMN alias_paths TEXT`);
  }
}

export function ensurePendingDecisionsColumn(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(projects)`).all() as TableInfoRow[];
  const hasPendingDecisions = columns.some((column) => column.name === 'pending_decisions');
  if (!hasPendingDecisions) {
    db.exec(`ALTER TABLE projects ADD COLUMN pending_decisions TEXT`);
  }
}

export function ensureChatSessionsAgentIdColumn(db: Database.Database): void {
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

export function ensureChatSessionsModelColumn(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(chat_sessions)`)
    .all() as TableInfoRow[];
  if (!columns.some((column) => column.name === 'model')) {
    db.exec(`ALTER TABLE chat_sessions ADD COLUMN model TEXT`);
  }
}

export function ensureChatSessionsTitleColumn(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(chat_sessions)`)
    .all() as TableInfoRow[];
  if (!columns.some((column) => column.name === 'title')) {
    db.exec(`ALTER TABLE chat_sessions ADD COLUMN title TEXT`);
  }
}

export function ensureChatSessionsPinnedColumn(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(chat_sessions)`)
    .all() as TableInfoRow[];
  if (!columns.some((column) => column.name === 'pinned')) {
    db.exec(`ALTER TABLE chat_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }
}

export function ensureChatMessagesFailedToolsColumn(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(chat_messages)`)
    .all() as TableInfoRow[];
  if (!columns.some((column) => column.name === 'failed_tools')) {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN failed_tools TEXT`);
  }
}

export function ensureChatMessagesAgentWarningsColumn(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(chat_messages)`)
    .all() as TableInfoRow[];
  if (!columns.some((column) => column.name === 'agent_warnings')) {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN agent_warnings TEXT`);
  }
}
