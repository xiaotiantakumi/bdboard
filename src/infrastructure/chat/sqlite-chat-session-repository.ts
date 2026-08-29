import type {
  ChatSessionRecord,
  ChatSessionRepository,
} from '../../application/ports/chat-session-repository.js';
import { CHAT_SESSION_MAX_PER_PROJECT } from '../../domain/chat.js';
import { openCacheDatabase } from '../cache/sqlite-board-cache.js';

export type SqliteChatSessionRepository = ChatSessionRepository & {
  readonly close: () => void;
};

interface CountRow {
  readonly count: number;
}

interface ChatSessionRow {
  readonly agentId: string;
  readonly model: string | null;
  readonly title: string | null;
  readonly pinned: number;
}

interface SessionListRow {
  readonly sessionId: string;
  readonly agentId: string;
  readonly lastUsedAt: string;
  readonly title: string | null;
  readonly pinned: number;
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
): SqliteChatSessionRepository {
  const maxSessionsPerProject =
    options?.maxSessionsPerProject ?? CHAT_SESSION_MAX_PER_PROJECT;

  const db = openCacheDatabase(dbPath);

  const rememberStmt = db.prepare(`
    INSERT OR IGNORE INTO chat_sessions (project_id, session_id, agent_id, last_used_at)
    VALUES (?, ?, ?, ?)
  `);
  const lookupStmt = db.prepare(`
    SELECT agent_id AS agentId, model, title, pinned
    FROM chat_sessions WHERE project_id = ? AND session_id = ? LIMIT 1
  `);
  const updateModelStmt = db.prepare(`
    UPDATE chat_sessions SET model = ? WHERE project_id = ? AND session_id = ?
  `);
  const renameStmt = db.prepare(`
    UPDATE chat_sessions SET title = ? WHERE project_id = ? AND session_id = ?
  `);
  const setPinnedStmt = db.prepare(`
    UPDATE chat_sessions SET pinned = ? WHERE project_id = ? AND session_id = ?
  `);
  const countForProjectStmt = db.prepare(
    `SELECT COUNT(*) AS count FROM chat_sessions WHERE project_id = ?`,
  );
  const updateLastUsedAtStmt = db.prepare(`
    UPDATE chat_sessions SET last_used_at = ?
    WHERE project_id = ? AND session_id = ?
  `);
  const selectTrimCandidatesStmt = db.prepare(`
    SELECT session_id AS sessionId FROM chat_sessions
    WHERE project_id = ?
      AND pinned = 0
      AND session_id != ?
    ORDER BY last_used_at ASC, rowid ASC
    LIMIT ?
  `);
  const deleteMessagesBySessionStmt = db.prepare(
    `DELETE FROM chat_messages WHERE session_id = ?`,
  );
  const deleteSessionStmt = db.prepare(
    `DELETE FROM chat_sessions WHERE project_id = ? AND session_id = ?`,
  );
  const listByProjectStmt = db.prepare(`
    SELECT session_id AS sessionId, agent_id AS agentId, last_used_at AS lastUsedAt,
           title, pinned
    FROM chat_sessions WHERE project_id = ? ORDER BY last_used_at DESC, rowid DESC
  `);
  const forgetStmt = db.prepare(`DELETE FROM chat_sessions WHERE project_id = ? AND session_id = ?`);

  interface TrimCandidateRow {
    readonly sessionId: string;
  }

  /**
   * cap 超過分の最古セッションを削除する。pinned 行と excludeSessionId は候補外。
   * 既存セッションがすべて pinned のときは unpinned 候補が無く何も削除されず、
   * cap を一時的に超過したままになる(意図した挙動)。
   */
  function trimOldestForProject(
    projectId: string,
    excludeSessionId: string,
    excess: number,
  ): void {
    if (excess <= 0) {
      return;
    }

    const candidates = selectTrimCandidatesStmt.all(
      projectId,
      excludeSessionId,
      excess,
    ) as TrimCandidateRow[];

    db.transaction(() => {
      for (const { sessionId: trimSessionId } of candidates) {
        deleteMessagesBySessionStmt.run(trimSessionId);
        deleteSessionStmt.run(projectId, trimSessionId);
      }
    })();
  }

  return {
    remember(projectId: string, sessionId: string, agentId: string): void {
      const now = new Date().toISOString();
      const result = rememberStmt.run(projectId, sessionId, agentId, now);
      if (result.changes === 0) {
        // 既知セッションIDへの remember は agentId を書き換えないが、
        // last_used_at は直近使用として更新する。
        updateLastUsedAtStmt.run(now, projectId, sessionId);
        return;
      }

      const { count } = countForProjectStmt.get(projectId) as CountRow;
      if (count > maxSessionsPerProject) {
        trimOldestForProject(
          projectId,
          sessionId,
          count - maxSessionsPerProject,
        );
      }
    },

    updateModel(projectId: string, sessionId: string, model: string): void {
      updateModelStmt.run(model, projectId, sessionId);
    },

    rename(projectId: string, sessionId: string, title: string | null): void {
      renameStmt.run(title, projectId, sessionId);
    },

    setPinned(projectId: string, sessionId: string, pinned: boolean): void {
      setPinnedStmt.run(pinned ? 1 : 0, projectId, sessionId);
    },

    lookup(projectId: string, sessionId: string): ChatSessionRecord | undefined {
      const row = lookupStmt.get(projectId, sessionId) as ChatSessionRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      return {
        agentId: row.agentId,
        ...(row.model !== null ? { model: row.model } : {}),
        ...(row.title !== null ? { title: row.title } : {}),
        ...(row.pinned !== 0 ? { pinned: true } : {}),
      };
    },

    listByProject(projectId: string) {
      return (listByProjectStmt.all(projectId) as SessionListRow[]).map((row) => ({
        sessionId: row.sessionId,
        agentId: row.agentId,
        lastUsedAt: new Date(row.lastUsedAt),
        title: row.title,
        pinned: row.pinned !== 0,
      }));
    },

    forget(projectId: string, sessionId: string): void {
      db.transaction(() => {
        forgetStmt.run(projectId, sessionId);
      })();
    },

    close(): void {
      // Windows ではオープン中の SQLite ファイルを unlink できない (EBUSY)。
      // graceful shutdown 後も接続が残ると cache.db のロックと WAL 補助ファイルが
      // 解放されない (bdboard-9dm)。POSIX では表面化しにくいが、close は必須。
      if (db.open) {
        db.close();
      }
    },
  };
}
