import type {
  ChatSessionRecord,
  ChatSessionRepository,
} from '../../application/ports/chat-session-repository.js';
import { CHAT_SESSION_MAX_PER_PROJECT } from '../../domain/chat.js';
import { openCacheDatabase } from '../cache/sqlite-board-cache.js';

interface CountRow {
  readonly count: number;
}

interface ChatSessionRow {
  readonly agentId: string;
  readonly model: string | null;
}

interface SessionListRow {
  readonly sessionId: string;
  readonly agentId: string;
  readonly lastUsedAt: string;
}

/**
 * chat_sessions テーブル (cache.db, sqlite-board-cache.ts が schema を管理) を
 * バックエンドにした ChatSessionRepository。
 *
 * cache.db への接続は sqlite-board-cache.ts の BoardCache 用接続とは別に自前で持つ
 * (better-sqlite3 は同一ファイルへの複数接続を WAL モードでサポートしている)。
 * こうすることで ChatSessionRepository は BoardCache のインターフェースに一切
 * 依存せず、独立した小さなポートのまま SQLite で永続化できる。
 */
export function createSqliteChatSessionRepository(
  dbPath: string,
  options?: { readonly maxSessionsPerProject?: number },
): ChatSessionRepository {
  const maxSessionsPerProject =
    options?.maxSessionsPerProject ?? CHAT_SESSION_MAX_PER_PROJECT;

  const db = openCacheDatabase(dbPath);

  const rememberStmt = db.prepare(`
    INSERT OR IGNORE INTO chat_sessions (project_id, session_id, agent_id, last_used_at)
    VALUES (?, ?, ?, ?)
  `);
  const lookupStmt = db.prepare(`
    SELECT agent_id AS agentId, model FROM chat_sessions WHERE project_id = ? AND session_id = ? LIMIT 1
  `);
  const updateModelStmt = db.prepare(`
    UPDATE chat_sessions SET model = ? WHERE project_id = ? AND session_id = ?
  `);
  const countForProjectStmt = db.prepare(
    `SELECT COUNT(*) AS count FROM chat_sessions WHERE project_id = ?`,
  );
  const trimOldestForProjectStmt = db.prepare(`
    DELETE FROM chat_sessions
    WHERE rowid IN (
      SELECT rowid FROM chat_sessions
      WHERE project_id = ?
      ORDER BY last_used_at ASC, rowid ASC
      LIMIT ?
    )
  `);
  const listByProjectStmt = db.prepare(`
    SELECT session_id AS sessionId, agent_id AS agentId, last_used_at AS lastUsedAt
    FROM chat_sessions WHERE project_id = ? ORDER BY last_used_at DESC, rowid DESC
  `);
  const forgetStmt = db.prepare(`DELETE FROM chat_sessions WHERE project_id = ? AND session_id = ?`);

  return {
    remember(projectId: string, sessionId: string, agentId: string): void {
      const result = rememberStmt.run(
        projectId,
        sessionId,
        agentId,
        new Date().toISOString(),
      );
      if (result.changes === 0) {
        // 既知セッションIDへの remember は in-memory 実装と同じく no-op
        // (最終使用順を更新しない = トリム対象の再計算もしない)。
        return;
      }

      const { count } = countForProjectStmt.get(projectId) as CountRow;
      if (count > maxSessionsPerProject) {
        trimOldestForProjectStmt.run(projectId, count - maxSessionsPerProject);
      }
    },

    updateModel(projectId: string, sessionId: string, model: string): void {
      updateModelStmt.run(model, projectId, sessionId);
    },

    lookup(projectId: string, sessionId: string): ChatSessionRecord | undefined {
      const row = lookupStmt.get(projectId, sessionId) as ChatSessionRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      return row.model === null
        ? { agentId: row.agentId }
        : { agentId: row.agentId, model: row.model };
    },

    listByProject(projectId: string) {
      return (listByProjectStmt.all(projectId) as SessionListRow[]).map((row) => ({
        sessionId: row.sessionId,
        agentId: row.agentId,
        lastUsedAt: new Date(row.lastUsedAt),
      }));
    },

    forget(projectId: string, sessionId: string): void {
      db.transaction(() => {
        forgetStmt.run(projectId, sessionId);
      })();
    },
  };
}
