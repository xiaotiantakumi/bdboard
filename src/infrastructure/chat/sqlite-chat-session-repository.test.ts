import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatSessionStore } from '../../application/chat/chat-session-store.js';
import { openCacheDatabase } from '../cache/sqlite-board-cache.js';
import { createSqliteChatSessionRepository } from './sqlite-chat-session-repository.js';

describe('createSqliteChatSessionRepository', () => {
  let tmpDir: string;
  let dbPath: string;

  afterEach(() => {
    if (tmpDir !== undefined) {
      const resolvedTmpDir = path.resolve(tmpDir);
      const resolvedTmpRoot = path.resolve(os.tmpdir());
      expect(resolvedTmpDir.startsWith(resolvedTmpRoot)).toBe(true);
      rmSync(resolvedTmpDir, { recursive: true, force: true });
    }
  });

  function makeTmpDbPath(prefix: string): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), prefix));
    dbPath = path.join(tmpDir, 'cache.db');
    return dbPath;
  }

  it('remembers a session id that a brand-new repository instance (same DB) recognizes', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-remember-');

    const first = createSqliteChatSessionRepository(path_);
    first.remember('project-a', 'session-1', 'claude');

    // 別インスタンス == サーバー再起動を模す。同じ DB ファイルを指すので、
    // 既知セッションIDの記憶が引き継がれているはず。
    const second = createSqliteChatSessionRepository(path_);
    expect(second.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
    });
    expect(second.lookup('project-a', 'session-unknown')).toBeUndefined();
  });

  it('round-trips agentId through remember and lookup', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-agent-id-');

    const repo = createSqliteChatSessionRepository(path_);
    repo.remember('project-a', 'session-1', 'codex');

    expect(repo.lookup('project-a', 'session-1')).toEqual({
      agentId: 'codex',
    });
  });

  it('round-trips model through updateModel and a restarted repository', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-model-');
    const first = createSqliteChatSessionRepository(path_);
    first.remember('project-a', 'session-1', 'claude');
    first.updateModel('project-a', 'session-1', 'opus');

    const second = createSqliteChatSessionRepository(path_);
    expect(second.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
      model: 'opus',
    });
  });

  it('omits model from lookup when it has not been set', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-model-unset-');
    const repo = createSqliteChatSessionRepository(path_);
    repo.remember('project-a', 'session-1', 'claude');

    expect(repo.lookup('project-a', 'session-1')).toEqual({ agentId: 'claude' });
  });

  it('drops the oldest sessions per project once the cap is exceeded, across restarts', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-cap-');

    const first = createSqliteChatSessionRepository(path_, {
      maxSessionsPerProject: 3,
    });
    first.remember('project-a', 'session-1', 'claude');
    first.remember('project-a', 'session-2', 'claude');
    first.remember('project-a', 'session-3', 'claude');

    // 4件目は別インスタンス (再起動後) から remember する。
    const second = createSqliteChatSessionRepository(path_, {
      maxSessionsPerProject: 3,
    });
    second.remember('project-a', 'session-4', 'claude');

    expect(second.lookup('project-a', 'session-1')).toBeUndefined();
    expect(second.lookup('project-a', 'session-2')).toEqual({
      agentId: 'claude',
    });
    expect(second.lookup('project-a', 'session-3')).toEqual({
      agentId: 'claude',
    });
    expect(second.lookup('project-a', 'session-4')).toEqual({
      agentId: 'claude',
    });
  });

  it('does not leak session ids across projects', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-projects-');

    const repo = createSqliteChatSessionRepository(path_);
    repo.remember('project-a', 'session-1', 'claude');

    expect(repo.lookup('project-b', 'session-1')).toBeUndefined();
  });

  it('lists only the requested project in newest-first order and forgets one session', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-list-');
    const repo = createSqliteChatSessionRepository(path_);
    repo.remember('project-a', 'session-old', 'claude');
    repo.remember('project-b', 'other-project', 'codex');
    repo.remember('project-a', 'session-new', 'codex');

    const listed = repo.listByProject('project-a');
    expect(listed.map((row) => row.sessionId)).toEqual(['session-new', 'session-old']);
    expect(listed.map((row) => row.agentId)).toEqual(['codex', 'claude']);

    repo.forget('project-a', 'session-new');
    expect(repo.listByProject('project-a').map((row) => row.sessionId)).toEqual(['session-old']);
    expect(repo.lookup('project-b', 'other-project')).toEqual({ agentId: 'codex' });
  });

  it('does not duplicate or reorder an already-known session id', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-dedupe-');

    const repo = createSqliteChatSessionRepository(path_, {
      maxSessionsPerProject: 2,
    });
    repo.remember('project-a', 'session-1', 'claude');
    repo.remember('project-a', 'session-2', 'claude');
    repo.remember('project-a', 'session-1', 'codex');

    expect(repo.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
    });
    expect(repo.lookup('project-a', 'session-2')).toEqual({
      agentId: 'claude',
    });
  });

  it('wires into createChatSessionStore and continues a thread across a simulated restart', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-store-');

    const before = createChatSessionStore({
      repository: createSqliteChatSessionRepository(path_),
    });
    before.remember('project-a', 'session-1', 'claude');
    expect(before.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
    });

    // 「サーバー再起動」= 新しい store インスタンス + 新しい repository インスタンス
    // (同じ dbPath)。acceptance criteria の「同じスレッドの続きを送信して
    // unknown-session にならない」を、store 層まで通して確認する。
    const after = createChatSessionStore({
      repository: createSqliteChatSessionRepository(path_),
    });
    expect(after.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
    });

    // ロックは repository を共有していてもストア再作成 (=再起動) で残留しない。
    expect(after.tryAcquire('project-a')).toBe(true);
  });

  it('migrates pre-agent_id rows to claude on restart', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-migrate-');

    const db = openCacheDatabase(path_);
    try {
      db.exec(`ALTER TABLE chat_sessions DROP COLUMN agent_id`);
    } catch {
      db.exec(`
        CREATE TABLE chat_sessions_legacy (
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          PRIMARY KEY (project_id, session_id)
        );
        INSERT INTO chat_sessions_legacy (project_id, session_id, last_used_at)
        SELECT project_id, session_id, last_used_at FROM chat_sessions;
        DROP TABLE chat_sessions;
        ALTER TABLE chat_sessions_legacy RENAME TO chat_sessions;
      `);
    }
    db.prepare(
      `INSERT INTO chat_sessions (project_id, session_id, last_used_at) VALUES (?, ?, ?)`,
    ).run('project-a', 'legacy-session', '2026-08-15T00:00:00.000Z');
    db.close();

    const repo = createSqliteChatSessionRepository(path_);
    expect(repo.lookup('project-a', 'legacy-session')).toEqual({
      agentId: 'claude',
    });
  });

  it('opens a database without model column and migrates model persistence', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-migrate-model-');
    const db = openCacheDatabase(path_);
    db.exec(`ALTER TABLE chat_sessions DROP COLUMN model`);
    db.prepare(
      `INSERT INTO chat_sessions (project_id, session_id, last_used_at, agent_id) VALUES (?, ?, ?, ?)`,
    ).run('project-a', 'legacy-session', '2026-08-15T00:00:00.000Z', 'claude');
    db.close();

    const repo = createSqliteChatSessionRepository(path_);
    expect(repo.lookup('project-a', 'legacy-session')).toEqual({
      agentId: 'claude',
    });
    repo.updateModel('project-a', 'legacy-session', 'opus');
    expect(repo.lookup('project-a', 'legacy-session')).toEqual({
      agentId: 'claude',
      model: 'opus',
    });
  });

  it('applies agent_id migration idempotently across two restarts', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-migrate-idempotent-');

    const db = openCacheDatabase(path_);
    try {
      db.exec(`ALTER TABLE chat_sessions DROP COLUMN agent_id`);
    } catch {
      db.exec(`
        CREATE TABLE chat_sessions_legacy (
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          PRIMARY KEY (project_id, session_id)
        );
        INSERT INTO chat_sessions_legacy (project_id, session_id, last_used_at)
        SELECT project_id, session_id, last_used_at FROM chat_sessions;
        DROP TABLE chat_sessions;
        ALTER TABLE chat_sessions_legacy RENAME TO chat_sessions;
      `);
    }
    db.prepare(
      `INSERT INTO chat_sessions (project_id, session_id, last_used_at) VALUES (?, ?, ?)`,
    ).run('project-a', 'legacy-session', '2026-08-15T00:00:00.000Z');
    db.close();

    const first = createSqliteChatSessionRepository(path_);
    expect(first.lookup('project-a', 'legacy-session')).toEqual({
      agentId: 'claude',
    });
    first.remember('project-a', 'new-session', 'codex');

    const second = createSqliteChatSessionRepository(path_);
    expect(second.lookup('project-a', 'legacy-session')).toEqual({
      agentId: 'claude',
    });
    expect(second.lookup('project-a', 'new-session')).toEqual({
      agentId: 'codex',
    });
  });
});
