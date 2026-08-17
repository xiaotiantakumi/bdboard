import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_MESSAGE_MAX_LENGTH } from '../../domain/chat.js';
import { createSqliteChatMessageRepository } from './sqlite-chat-message-repository.js';

describe('createSqliteChatMessageRepository', () => {
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

  it('round-trips messages across repository restarts', () => {
    const path_ = makeTmpDbPath('bdboard-chat-messages-roundtrip-');
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    const at = new Date('2026-08-16T03:00:00.000Z');

    const first = createSqliteChatMessageRepository(path_);
    first.append(sessionId, [
      { role: 'user', content: 'hello', createdAt: at },
      { role: 'assistant', content: 'hi', createdAt: at },
    ]);

    const rawDb = new Database(path_);
    rawDb
      .prepare(
        `INSERT INTO chat_sessions (project_id, session_id, last_used_at, agent_id) VALUES (?, ?, ?, ?)`,
      )
      .run('project-roundtrip', sessionId, '2026-08-16T03:00:00.000Z', 'claude');
    rawDb.close();

    const second = createSqliteChatMessageRepository(path_);
    expect(second.listBySession(sessionId)).toEqual([
      { role: 'user', content: 'hello', createdAt: at },
      { role: 'assistant', content: 'hi', createdAt: at },
    ]);
  });

  it('round-trips failedTools alongside messages, omitting the field when absent (bdboard-ftn)', () => {
    const path_ = makeTmpDbPath('bdboard-chat-messages-failed-tools-roundtrip-');
    const sessionId = '550e8400-e29b-41d4-a716-446655440098';
    const at = new Date('2026-08-16T03:00:00.000Z');

    const first = createSqliteChatMessageRepository(path_);
    first.append(sessionId, [
      { role: 'user', content: 'hello', createdAt: at },
      {
        role: 'assistant',
        content: 'hi, but some tools failed',
        createdAt: at,
        failedTools: ['bd_ready', 'bd_close'],
      },
    ]);

    const rawDb = new Database(path_);
    rawDb
      .prepare(
        `INSERT INTO chat_sessions (project_id, session_id, last_used_at, agent_id) VALUES (?, ?, ?, ?)`,
      )
      .run('project-failed-tools-roundtrip', sessionId, '2026-08-16T03:00:00.000Z', 'claude');
    rawDb.close();

    const second = createSqliteChatMessageRepository(path_);
    expect(second.listBySession(sessionId)).toEqual([
      { role: 'user', content: 'hello', createdAt: at },
      {
        role: 'assistant',
        content: 'hi, but some tools failed',
        createdAt: at,
        failedTools: ['bd_ready', 'bd_close'],
      },
    ]);
  });

  it('round-trips agentWarnings alongside messages, omitting the field when absent (bdboard-l1t.6 N-e)', () => {
    const path_ = makeTmpDbPath('bdboard-chat-messages-agent-warnings-roundtrip-');
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    const at = new Date('2026-08-16T03:00:00.000Z');

    const first = createSqliteChatMessageRepository(path_);
    first.append(sessionId, [
      { role: 'user', content: 'hello', createdAt: at },
      {
        role: 'assistant',
        content: 'partial but warned',
        createdAt: at,
        agentWarnings: ['headless auto-deny: some tool call(s) were soft-denied mid-turn'],
      },
    ]);

    const rawDb = new Database(path_);
    rawDb
      .prepare(
        `INSERT INTO chat_sessions (project_id, session_id, last_used_at, agent_id) VALUES (?, ?, ?, ?)`,
      )
      .run('project-agent-warnings-roundtrip', sessionId, '2026-08-16T03:00:00.000Z', 'agy');
    rawDb.close();

    const second = createSqliteChatMessageRepository(path_);
    expect(second.listBySession(sessionId)).toEqual([
      { role: 'user', content: 'hello', createdAt: at },
      {
        role: 'assistant',
        content: 'partial but warned',
        createdAt: at,
        agentWarnings: ['headless auto-deny: some tool call(s) were soft-denied mid-turn'],
      },
    ]);
  });

  it('adds agent_warnings column when migrating an older chat_messages table in place (bdboard-l1t.6 N-e)', () => {
    const path_ = makeTmpDbPath('bdboard-chat-messages-agent-warnings-migrate-');
    const sessionId = 'sess-agent-warnings-migrate';
    const at = new Date('2026-08-16T03:00:00.000Z');

    const rawDb = new Database(path_);
    rawDb.exec(`
      CREATE TABLE chat_sessions (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'claude',
        PRIMARY KEY (project_id, session_id)
      );
      CREATE TABLE chat_messages (
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        failed_tools TEXT
      );
    `);
    rawDb
      .prepare(
        `INSERT INTO chat_sessions (project_id, session_id, last_used_at, agent_id) VALUES (?, ?, ?, ?)`,
      )
      .run('project-migrate', sessionId, '2026-08-16T03:00:00.000Z', 'agy');
    rawDb
      .prepare(
        `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, 'assistant', 'legacy reply', at.toISOString());
    rawDb.close();

    const repo = createSqliteChatMessageRepository(path_);
    repo.append(sessionId, [
      {
        role: 'assistant',
        content: 'warned reply',
        createdAt: at,
        agentWarnings: ['warning one'],
      },
    ]);

    const columns = new Database(path_)
      .prepare(`PRAGMA table_info(chat_messages)`)
      .all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'agent_warnings')).toBe(true);
    expect(repo.listBySession(sessionId)).toEqual([
      { role: 'assistant', content: 'legacy reply', createdAt: at },
      {
        role: 'assistant',
        content: 'warned reply',
        createdAt: at,
        agentWarnings: ['warning one'],
      },
    ]);
  });

  it('trims the oldest messages once the per-session cap is exceeded', () => {
    const path_ = makeTmpDbPath('bdboard-chat-messages-cap-');

    const repo = createSqliteChatMessageRepository(path_, {
      maxMessagesPerSession: 3,
    });
    const sessionId = 'sess-cap';

    repo.append(sessionId, [{ role: 'user', content: 'm1' }]);
    repo.append(sessionId, [{ role: 'assistant', content: 'm2' }]);
    repo.append(sessionId, [{ role: 'user', content: 'm3' }]);
    repo.append(sessionId, [{ role: 'assistant', content: 'm4' }]);

    expect(repo.listBySession(sessionId).map((row) => row.content)).toEqual([
      'm2',
      'm3',
      'm4',
    ]);
  });

  it('omits agentWarnings rather than throwing when the stored value is not a JSON string array (bdboard-l1t.6 N-e)', () => {
    const path_ = makeTmpDbPath('bdboard-chat-messages-agent-warnings-garbage-');
    const repo = createSqliteChatMessageRepository(path_);
    const sessionId = 'session-agent-warnings-garbage';
    repo.append(sessionId, [{ role: 'assistant', content: 'ok' }]);

    const rawDb = new Database(path_);
    rawDb
      .prepare(`UPDATE chat_messages SET agent_warnings = ? WHERE session_id = ?`)
      .run('not json', sessionId);
    rawDb.close();

    expect(repo.listBySession(sessionId)).toEqual([
      { role: 'assistant', content: 'ok', createdAt: expect.any(Date) },
    ]);
  });

  it('deletes only messages belonging to the requested session', () => {
    const path_ = makeTmpDbPath('bdboard-chat-messages-delete-');
    const repo = createSqliteChatMessageRepository(path_);
    repo.append('session-a', [{ role: 'user', content: 'remove me' }]);
    repo.append('session-b', [{ role: 'user', content: 'keep me' }]);

    repo.deleteBySession('session-a');

    expect(repo.listBySession('session-a')).toEqual([]);
    expect(repo.listBySession('session-b').map((row) => row.content)).toEqual(['keep me']);
  });

  it('works against a v5 database upgraded in place to v6', () => {
    const path_ = makeTmpDbPath('bdboard-chat-messages-v5-migrate-');

    const rawDb = new Database(path_);
    rawDb.exec(`
      CREATE TABLE chat_sessions (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'claude',
        PRIMARY KEY (project_id, session_id)
      );
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '5');
    `);
    rawDb.prepare(
      `INSERT INTO chat_sessions (project_id, session_id, last_used_at, agent_id) VALUES (?, ?, ?, ?)`,
    ).run('project-a', 'session-1', '2026-08-16T03:00:00.000Z', 'claude');
    rawDb.close();

    const messages = createSqliteChatMessageRepository(path_);
    messages.append('session-1', [{ role: 'user', content: 'stored' }]);
    expect(messages.listBySession('session-1')).toEqual([
      expect.objectContaining({ role: 'user', content: 'stored' }),
    ]);

    const reopened = new Database(path_);
    const versionRow = reopened
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { readonly value: string };
    expect(versionRow.value).toBe('6');
    reopened.close();
  });

  it('migrates a v6 chat_messages table without failed_tools in place, preserving existing rows (bdboard-ftn)', () => {
    const path_ = makeTmpDbPath('bdboard-chat-messages-failed-tools-migrate-');

    const rawDb = new Database(path_);
    rawDb.exec(`
      CREATE TABLE chat_sessions (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'claude',
        PRIMARY KEY (project_id, session_id)
      );
      CREATE TABLE chat_messages (
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '6');
    `);
    rawDb.prepare(
      `INSERT INTO chat_sessions (project_id, session_id, last_used_at, agent_id) VALUES (?, ?, ?, ?)`,
    ).run('project-a', 'session-legacy', '2026-08-16T03:00:00.000Z', 'claude');
    rawDb.prepare(
      `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
    ).run('session-legacy', 'user', 'pre-migration message', '2026-08-16T03:00:00.000Z');
    rawDb.close();

    const repo = createSqliteChatMessageRepository(path_);

    // 移行前から存在した行は failedTools 無しで読めること (既存データを壊さない)。
    expect(repo.listBySession('session-legacy')).toEqual([
      {
        role: 'user',
        content: 'pre-migration message',
        createdAt: new Date('2026-08-16T03:00:00.000Z'),
      },
    ]);

    repo.append('session-legacy', [
      { role: 'assistant', content: 'post-migration reply', failedTools: ['bd_ready'] },
    ]);
    const messages = repo.listBySession('session-legacy');
    expect(messages[1]).toEqual(
      expect.objectContaining({
        content: 'post-migration reply',
        failedTools: ['bd_ready'],
      }),
    );

    const reopened = new Database(path_);
    const columns = reopened
      .prepare(`PRAGMA table_info(chat_messages)`)
      .all() as { readonly name: string }[];
    expect(columns.some((column) => column.name === 'failed_tools')).toBe(true);
    const versionRow = reopened
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { readonly value: string };
    // in-place migration なので SCHEMA_VERSION は上げない。
    expect(versionRow.value).toBe('6');
    reopened.close();
  });

  it('omits failedTools rather than throwing when the stored value is not a JSON string array (bdboard-ftn)', () => {
    const path_ = makeTmpDbPath('bdboard-chat-messages-failed-tools-garbage-');
    const repo = createSqliteChatMessageRepository(path_);
    const sessionId = 'session-garbage';
    repo.append(sessionId, [{ role: 'assistant', content: 'ok' }]);

    const rawDb = new Database(path_);
    rawDb
      .prepare(`UPDATE chat_messages SET failed_tools = ? WHERE session_id = ?`)
      .run('not json', sessionId);
    rawDb.close();

    expect(repo.listBySession(sessionId)).toEqual([
      { role: 'assistant', content: 'ok', createdAt: expect.any(Date) },
    ]);
  });

  it('removes orphan chat_messages rows without a parent session on repository creation', () => {
    const path_ = makeTmpDbPath('bdboard-chat-messages-orphan-sweep-');

    const rawDb = new Database(path_);
    rawDb.exec(`
      CREATE TABLE chat_sessions (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'claude',
        PRIMARY KEY (project_id, session_id)
      );
      CREATE TABLE chat_messages (
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '6');
    `);
    rawDb.prepare(
      `INSERT INTO chat_sessions (project_id, session_id, last_used_at, agent_id) VALUES (?, ?, ?, ?)`,
    ).run('project-a', 'session-live', '2026-08-16T03:00:00.000Z', 'claude');
    rawDb.prepare(
      `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
    ).run(
      'session-live',
      'user',
      'keep me',
      '2026-08-16T03:00:00.000Z',
    );
    rawDb.prepare(
      `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
    ).run(
      'session-orphan',
      'user',
      'delete me',
      '2026-08-16T03:00:01.000Z',
    );
    rawDb.close();

    const repo = createSqliteChatMessageRepository(path_);
    expect(repo.listBySession('session-live').map((row) => row.content)).toEqual([
      'keep me',
    ]);
    expect(repo.listBySession('session-orphan')).toEqual([]);

    const reopened = new Database(path_);
    const orphanCount = reopened
      .prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?`)
      .get('session-orphan') as { readonly count: number };
    expect(orphanCount.count).toBe(0);
    reopened.close();
  });

  it('returns grouped thread summaries without loading full messages', () => {
    const path_ = makeTmpDbPath('bdboard-chat-thread-summaries-');
    const repo = createSqliteChatMessageRepository(path_);
    const messagesBySession = {
      'session-a': [
        { role: 'assistant' as const, content: 'welcome', createdAt: new Date('2026-08-16T03:00:00.000Z') },
        { role: 'user' as const, content: 'first question', createdAt: new Date('2026-08-16T03:01:00.000Z') },
        { role: 'assistant' as const, content: 'answer', createdAt: new Date('2026-08-16T03:02:00.000Z') },
      ],
      'session-b': [
        { role: 'user' as const, content: 'another question', createdAt: new Date('2026-08-16T04:00:00.000Z') },
        { role: 'user' as const, content: 'follow-up', createdAt: new Date('2026-08-16T04:01:00.000Z') },
      ],
    };
    for (const [sessionId, messages] of Object.entries(messagesBySession)) {
      repo.append(sessionId, messages);
    }

    const expected = new Map(
      Object.entries(messagesBySession).map(([sessionId, messages]) => {
        const firstUser = messages.find((message) => message.role === 'user');
        const lastMessageAt = messages.reduce(
          (latest, message) => (message.createdAt > latest ? message.createdAt : latest),
          messages[0].createdAt,
        );
        return [sessionId, {
          firstUserContentPrefix:
            firstUser === undefined
              ? undefined
              : Array.from(firstUser.content).slice(0, CHAT_MESSAGE_MAX_LENGTH).join(''),
          lastMessageAt,
        }];
      }),
    );

    expect(repo.listThreadSummaries(['session-a', 'session-b'])).toEqual(expected);
  });

  it('handles empty sessions, code-point prefixes, boundary lengths, and empty input', () => {
    const path_ = makeTmpDbPath('bdboard-chat-thread-summary-details-');
    const repo = createSqliteChatMessageRepository(path_);
    const unicodeContent = `${'😀'.repeat(CHAT_MESSAGE_MAX_LENGTH - 1)}Z`;
    repo.append('session-unicode', [{
      role: 'user',
      content: unicodeContent,
      createdAt: new Date('2026-08-16T05:00:00.000Z'),
    }]);
    repo.append('session-40', [{
      role: 'user',
      content: 'a'.repeat(40),
      createdAt: new Date('2026-08-16T05:01:00.000Z'),
    }]);
    repo.append('session-41', [{
      role: 'user',
      content: 'b'.repeat(41),
      createdAt: new Date('2026-08-16T05:02:00.000Z'),
    }]);

    const summaries = repo.listThreadSummaries([
      'session-unicode',
      'session-40',
      'session-41',
      'empty-session',
    ]);
    expect(summaries.get('session-unicode')).toEqual({
      firstUserContentPrefix: Array.from(unicodeContent).slice(0, CHAT_MESSAGE_MAX_LENGTH).join(''),
      lastMessageAt: new Date('2026-08-16T05:00:00.000Z'),
    });
    // 上限長ちょうどのメッセージでは prefix が全文と厳密一致する (SUBSTR/slice の上限 = CHAT_MESSAGE_MAX_LENGTH の同値性)
    expect(Array.from(unicodeContent)).toHaveLength(CHAT_MESSAGE_MAX_LENGTH);
    expect(summaries.get('session-unicode')?.firstUserContentPrefix).toBe(unicodeContent);
    expect(summaries.get('session-40')?.firstUserContentPrefix).toBe('a'.repeat(40));
    expect(summaries.get('session-41')?.firstUserContentPrefix).toBe('b'.repeat(41));
    expect(summaries.has('empty-session')).toBe(false);
    expect(repo.listThreadSummaries([])).toEqual(new Map());
  });
});
