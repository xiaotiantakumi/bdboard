import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatSessionStore } from '../../application/chat/chat-session-store.js';
import { openCacheDatabase } from '../cache/sqlite-board-cache.js';
import {
  createSqliteChatSessionRepository,
  type SqliteChatSessionRepository,
} from './sqlite-chat-session-repository.js';

// bdboard-ma4: 一時ディレクトリに file-backed な sqlite DB を作るテストは、Windows の
// CI runner で散発的に数秒のI/Oストールを食らう (新規作成される .db/-wal/-shm への
// AV スキャンが有力)。同一 run で file-backed sqlite のテストファイルだけが 2〜9倍に
// 膨らみ、非 sqlite のファイル (chokidar 1298→1302ms 等) は無風だったことを CI ログで
// 確認している。テスト自体は軽い (ローカルでは1件あたり数十ms) ので、アサーションは
// 変えずに待ち時間だけこのファイル単位で伸ばす。全体の testTimeout を上げないのは、
// 173 のテストファイル全部で本物のハングの検知が遅くなるため。30s で必ず落ちるので
// 「無限に待つ」方向には倒していない。
vi.setConfig({ testTimeout: 30_000 });

describe('createSqliteChatSessionRepository', () => {
  let tmpDir: string;
  let dbPath: string;
  const closables: Array<{ close(): void }> = [];

  afterEach(() => {
    for (const closeable of closables) {
      closeable.close();
    }
    closables.length = 0;

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

  function openRepo(
    path_: string,
    options?: { readonly maxSessionsPerProject?: number },
  ): SqliteChatSessionRepository {
    const repo = createSqliteChatSessionRepository(path_, options);
    closables.push(repo);
    return repo;
  }

  function openCacheDb(path_: string): ReturnType<typeof openCacheDatabase> {
    const db = openCacheDatabase(path_);
    closables.push({
      close() {
        if (db.open) {
          db.close();
        }
      },
    });
    return db;
  }

  it('remembers a session id that a brand-new repository instance (same DB) recognizes', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-remember-');

    const first = openRepo(path_);
    first.remember('project-a', 'session-1', 'claude');

    // 別インスタンス == サーバー再起動を模す。同じ DB ファイルを指すので、
    // 既知セッションIDの記憶が引き継がれているはず。
    const second = openRepo(path_);
    expect(second.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
    });
    expect(second.lookup('project-a', 'session-unknown')).toBeUndefined();
  });

  it('round-trips agentId through remember and lookup', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-agent-id-');

    const repo = openRepo(path_);
    repo.remember('project-a', 'session-1', 'codex');

    expect(repo.lookup('project-a', 'session-1')).toEqual({
      agentId: 'codex',
    });
  });

  it('round-trips model through updateModel and a restarted repository', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-model-');
    const first = openRepo(path_);
    first.remember('project-a', 'session-1', 'claude');
    first.updateModel('project-a', 'session-1', 'opus');

    const second = openRepo(path_);
    expect(second.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
      model: 'opus',
    });
  });

  it('omits model from lookup when it has not been set', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-model-unset-');
    const repo = openRepo(path_);
    repo.remember('project-a', 'session-1', 'claude');

    expect(repo.lookup('project-a', 'session-1')).toEqual({ agentId: 'claude' });
  });

  it('drops the oldest sessions per project once the cap is exceeded, across restarts', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-cap-');

    const first = openRepo(path_, {
      maxSessionsPerProject: 3,
    });
    first.remember('project-a', 'session-1', 'claude');
    first.remember('project-a', 'session-2', 'claude');
    first.remember('project-a', 'session-3', 'claude');

    // 4件目は別インスタンス (再起動後) から remember する。
    const second = openRepo(path_, {
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

    const repo = openRepo(path_);
    repo.remember('project-a', 'session-1', 'claude');

    expect(repo.lookup('project-b', 'session-1')).toBeUndefined();
  });

  it('lists only the requested project in newest-first order and forgets one session', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-list-');
    const repo = openRepo(path_);
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

    const repo = openRepo(path_, {
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
      repository: openRepo(path_),
    });
    before.remember('project-a', 'session-1', 'claude');
    expect(before.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
    });

    // 「サーバー再起動」= 新しい store インスタンス + 新しい repository インスタンス
    // (同じ dbPath)。acceptance criteria の「同じスレッドの続きを送信して
    // unknown-session にならない」を、store 層まで通して確認する。
    const after = createChatSessionStore({
      repository: openRepo(path_),
    });
    expect(after.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
    });

    // ロックは repository を共有していてもストア再作成 (=再起動) で残留しない。
    expect(after.tryAcquire('project-a')).toBe(true);
  });

  it('migrates pre-agent_id rows to claude on restart', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-migrate-');

    const db = openCacheDb(path_);
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

    const repo = openRepo(path_);
    expect(repo.lookup('project-a', 'legacy-session')).toEqual({
      agentId: 'claude',
    });
  });

  it('opens a database without model column and migrates model persistence', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-migrate-model-');
    const db = openCacheDb(path_);
    db.exec(`ALTER TABLE chat_sessions DROP COLUMN model`);
    db.prepare(
      `INSERT INTO chat_sessions (project_id, session_id, last_used_at, agent_id) VALUES (?, ?, ?, ?)`,
    ).run('project-a', 'legacy-session', '2026-08-15T00:00:00.000Z', 'claude');
    db.close();

    const repo = openRepo(path_);
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

    const db = openCacheDb(path_);
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

    const first = openRepo(path_);
    expect(first.lookup('project-a', 'legacy-session')).toEqual({
      agentId: 'claude',
    });
    first.remember('project-a', 'new-session', 'codex');

    const second = openRepo(path_);
    expect(second.lookup('project-a', 'legacy-session')).toEqual({
      agentId: 'claude',
    });
    expect(second.lookup('project-a', 'new-session')).toEqual({
      agentId: 'codex',
    });
  });

  it('round-trips title and pinned through rename, setPinned, lookup, and listByProject', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-title-pinned-');
    const first = openRepo(path_);
    first.remember('project-a', 'session-1', 'claude');
    first.rename('project-a', 'session-1', '運用相談');
    first.setPinned('project-a', 'session-1', true);

    const second = openRepo(path_);
    expect(second.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
      title: '運用相談',
      pinned: true,
    });
    expect(second.listByProject('project-a')).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        title: '運用相談',
        pinned: true,
      }),
    ]);
  });

  it('clears a custom title when rename is called with null', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-title-clear-');
    const repo = openRepo(path_);
    repo.remember('project-a', 'session-1', 'claude');
    repo.rename('project-a', 'session-1', '運用相談');
    repo.rename('project-a', 'session-1', null);

    expect(repo.lookup('project-a', 'session-1')).toEqual({ agentId: 'claude' });
    expect(repo.listByProject('project-a')[0]?.title).toBeNull();
    expect(repo.listByProject('project-a')[0]?.pinned).toBe(false);
  });

  it('opens a database without title/pinned columns and migrates persistence', () => {
    const path_ = makeTmpDbPath('bdboard-chat-sessions-migrate-title-pinned-');
    const db = openCacheDb(path_);
    db.exec(`ALTER TABLE chat_sessions DROP COLUMN title`);
    db.exec(`ALTER TABLE chat_sessions DROP COLUMN pinned`);
    db.prepare(
      `INSERT INTO chat_sessions (project_id, session_id, last_used_at, agent_id) VALUES (?, ?, ?, ?)`,
    ).run('project-a', 'legacy-session', '2026-08-15T00:00:00.000Z', 'claude');
    db.close();

    const repo = openRepo(path_);
    expect(repo.listByProject('project-a')[0]).toEqual(
      expect.objectContaining({
        sessionId: 'legacy-session',
        title: null,
        pinned: false,
      }),
    );
    repo.rename('project-a', 'legacy-session', 'legacy title');
    repo.setPinned('project-a', 'legacy-session', true);

    const restarted = openRepo(path_);
    expect(restarted.lookup('project-a', 'legacy-session')).toEqual({
      agentId: 'claude',
      title: 'legacy title',
      pinned: true,
    });
  });
});
