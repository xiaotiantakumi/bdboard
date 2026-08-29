import type {
  ChatMessageAppendInput,
  ChatMessageRecord,
  ChatMessageRepository,
  ChatMessageRole,
  ChatThreadSummary,
} from '../../application/ports/chat-message-repository.js';
import { CHAT_MESSAGES_MAX_PER_SESSION, CHAT_MESSAGE_MAX_LENGTH } from '../../domain/chat.js';
import { openCacheDatabase } from '../cache/sqlite-board-cache.js';

export type SqliteChatMessageRepository = ChatMessageRepository & {
  readonly close: () => void;
};

interface CountRow {
  readonly count: number;
}

interface ChatMessageRowDb {
  readonly role: string;
  readonly content: string;
  readonly created_at: string;
  readonly failed_tools: string | null;
  readonly agent_warnings: string | null;
}

interface ChatThreadSummaryRowDb {
  readonly session_id: string;
  readonly first_user_prefix: string | null;
  readonly last_created_at: string;
}

function parseRole(raw: string): ChatMessageRole | undefined {
  if (raw === 'user' || raw === 'assistant') {
    return raw;
  }
  return undefined;
}

/**
 * chat_messages テーブル (cache.db, sqlite-board-cache.ts が schema を管理) を
 * バックエンドにした ChatMessageRepository。
 */
export function createSqliteChatMessageRepository(
  dbPath: string,
  options?: { readonly maxMessagesPerSession?: number },
): SqliteChatMessageRepository {
  const maxMessagesPerSession =
    options?.maxMessagesPerSession ?? CHAT_MESSAGES_MAX_PER_SESSION;

  const db = openCacheDatabase(dbPath);

  db.exec(`
    DELETE FROM chat_messages
    WHERE session_id NOT IN (SELECT session_id FROM chat_sessions)
  `);

  const insertStmt = db.prepare(`
    INSERT INTO chat_messages (session_id, role, content, created_at, failed_tools, agent_warnings)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listStmt = db.prepare(`
    SELECT role, content, created_at, failed_tools, agent_warnings
    FROM chat_messages
    WHERE session_id = ?
    ORDER BY created_at ASC, rowid ASC
  `);
  const countForSessionStmt = db.prepare(
    `SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?`,
  );
  const trimOldestForSessionStmt = db.prepare(`
    DELETE FROM chat_messages
    WHERE rowid IN (
      SELECT rowid FROM chat_messages
      WHERE session_id = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ?
    )
  `);
  const deleteBySessionStmt = db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`);

  const trimToCap = (sessionId: string): void => {
    const { count } = countForSessionStmt.get(sessionId) as CountRow;
    if (count <= maxMessagesPerSession) {
      return;
    }
    trimOldestForSessionStmt.run(sessionId, count - maxMessagesPerSession);
  };

  return {
    append(sessionId: string, messages: readonly ChatMessageAppendInput[]): void {
      if (messages.length === 0) {
        return;
      }

      const writeMany = db.transaction((entries: readonly ChatMessageAppendInput[]) => {
        for (const message of entries) {
          insertStmt.run(
            sessionId,
            message.role,
            message.content,
            (message.createdAt ?? new Date()).toISOString(),
            message.failedTools !== undefined && message.failedTools.length > 0
              ? JSON.stringify(message.failedTools)
              : null,
            message.agentWarnings !== undefined && message.agentWarnings.length > 0
              ? JSON.stringify(message.agentWarnings)
              : null,
          );
        }
        trimToCap(sessionId);
      });
      writeMany(messages);
    },

    listBySession(sessionId: string): readonly ChatMessageRecord[] {
      const rows = listStmt.all(sessionId) as ChatMessageRowDb[];
      const records: ChatMessageRecord[] = [];
      for (const row of rows) {
        const role = parseRole(row.role);
        if (role === undefined) {
          continue;
        }
        const failedTools = parseJsonStringArray(row.failed_tools);
        const agentWarnings = parseJsonStringArray(row.agent_warnings);
        records.push({
          role,
          content: row.content,
          createdAt: new Date(row.created_at),
          ...(failedTools !== undefined ? { failedTools } : {}),
          ...(agentWarnings !== undefined ? { agentWarnings } : {}),
        });
      }
      return records;
    },

    listThreadSummaries(sessionIds: readonly string[]): ReadonlyMap<string, ChatThreadSummary> {
      if (sessionIds.length === 0) {
        return new Map();
      }

      const placeholders = sessionIds.map(() => '?').join(', ');
      const summaryStmt = db.prepare(`
        SELECT
          messages.session_id,
          (
            SELECT SUBSTR(first_user.content, 1, ${CHAT_MESSAGE_MAX_LENGTH})
            FROM chat_messages AS first_user
            WHERE first_user.session_id = messages.session_id
              AND first_user.role = 'user'
            ORDER BY first_user.created_at ASC, first_user.rowid ASC
            LIMIT 1
          ) AS first_user_prefix,
          MAX(messages.created_at) AS last_created_at
        FROM chat_messages AS messages
        WHERE messages.session_id IN (${placeholders})
        GROUP BY messages.session_id
      `);
      const rows = summaryStmt.all(...sessionIds) as ChatThreadSummaryRowDb[];
      return new Map(
        rows.map((row) => [
          row.session_id,
          {
            firstUserContentPrefix: row.first_user_prefix ?? undefined,
            lastMessageAt: new Date(row.last_created_at),
          },
        ]),
      );
    },

    deleteBySession(sessionId: string): void {
      db.transaction(() => {
        deleteBySessionStmt.run(sessionId);
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

function parseJsonStringArray(raw: string | null | undefined): readonly string[] | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string')) {
      return undefined;
    }
    return parsed.length === 0 ? undefined : parsed;
  } catch {
    return undefined;
  }
}
