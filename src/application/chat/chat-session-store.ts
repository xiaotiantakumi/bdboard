import { CHAT_SESSION_MAX_PER_PROJECT } from '../../domain/chat.js';
import type {
  ChatSessionRecord,
  ChatSessionRepository,
} from '../ports/chat-session-repository.js';

export interface ChatSessionStore {
  remember(projectId: string, sessionId: string, agentId: string): void;
  updateModel(projectId: string, sessionId: string, model: string): void;
  rename(projectId: string, sessionId: string, title: string | null): void;
  setPinned(projectId: string, sessionId: string, pinned: boolean): void;
  lookup(projectId: string, sessionId: string): ChatSessionRecord | undefined;
  listByProject(projectId: string): ReturnType<ChatSessionRepository['listByProject']>;
  forget(projectId: string, sessionId: string): void;
  tryAcquire(projectId: string): boolean;
  isBusy(projectId: string): boolean;
  release(projectId: string): void;
}

interface ProjectSessionEntry {
  readonly order: string[];
  readonly known: Map<string, ChatSessionRecord>;
}

/**
 * プロセス内メモリのみで完結する ChatSessionRepository。
 * サーバー再起動で記憶が消える (createChatSessionStore のデフォルト実装、およびテスト用)。
 */
export function createInMemoryChatSessionRepository(options?: {
  readonly maxSessionsPerProject?: number;
}): ChatSessionRepository {
  const maxSessionsPerProject =
    options?.maxSessionsPerProject ?? CHAT_SESSION_MAX_PER_PROJECT;
  const sessionsByProject = new Map<string, ProjectSessionEntry>();

  const getOrCreateEntry = (projectId: string): ProjectSessionEntry => {
    let entry = sessionsByProject.get(projectId);
    if (entry === undefined) {
      entry = { order: [], known: new Map() };
      sessionsByProject.set(projectId, entry);
    }
    return entry;
  };

  const trimToMax = (entry: ProjectSessionEntry): void => {
    while (entry.order.length > maxSessionsPerProject) {
      const oldest = entry.order.shift();
      if (oldest !== undefined) {
        entry.known.delete(oldest);
      }
    }
  };

  return {
    remember(projectId: string, sessionId: string, agentId: string): void {
      const entry = getOrCreateEntry(projectId);
      if (entry.known.has(sessionId)) {
        return;
      }

      entry.order.push(sessionId);
      entry.known.set(sessionId, { agentId });
      trimToMax(entry);
    },

    updateModel(projectId: string, sessionId: string, model: string): void {
      const entry = sessionsByProject.get(projectId);
      const record = entry?.known.get(sessionId);
      if (entry === undefined || record === undefined) {
        return;
      }
      entry.known.set(sessionId, { ...record, model });
    },

    rename(projectId: string, sessionId: string, title: string | null): void {
      const entry = sessionsByProject.get(projectId);
      const record = entry?.known.get(sessionId);
      if (entry === undefined || record === undefined) {
        return;
      }
      if (title === null) {
        const { title: _removed, ...rest } = record;
        entry.known.set(sessionId, rest);
        return;
      }
      entry.known.set(sessionId, { ...record, title });
    },

    setPinned(projectId: string, sessionId: string, pinned: boolean): void {
      const entry = sessionsByProject.get(projectId);
      const record = entry?.known.get(sessionId);
      if (entry === undefined || record === undefined) {
        return;
      }
      entry.known.set(sessionId, { ...record, pinned });
    },

    lookup(projectId: string, sessionId: string): ChatSessionRecord | undefined {
      const entry = sessionsByProject.get(projectId);
      return entry?.known.get(sessionId);
    },

    listByProject(projectId: string) {
      const entry = sessionsByProject.get(projectId);
      return [...(entry?.order ?? [])].reverse().map((sessionId) => {
        const record = entry!.known.get(sessionId)!;
        return {
          sessionId,
          agentId: record.agentId,
          lastUsedAt: new Date(0),
          title: record.title ?? null,
          pinned: record.pinned ?? false,
        };
      });
    },

    forget(projectId: string, sessionId: string): void {
      const entry = sessionsByProject.get(projectId);
      if (entry === undefined || !entry.known.delete(sessionId)) return;
      entry.order.splice(entry.order.indexOf(sessionId), 1);
    },
  };
}

export function createChatSessionStore(options?: {
  readonly maxSessionsPerProject?: number;
  /**
   * remember/lookup の永続化先。未指定ならプロセス内メモリのみ (再起動で消える)。
   * サーバー再起動をまたいで継続チャットを許可したい場合は、SQLite 等で永続化した
   * 実装 (例: createSqliteChatSessionRepository) を渡す。
   */
  readonly repository?: ChatSessionRepository;
}): ChatSessionStore {
  const repository =
    options?.repository ??
    createInMemoryChatSessionRepository({
      maxSessionsPerProject: options?.maxSessionsPerProject,
    });

  // ロックはプロセス内限定の概念 (排他制御) なので、repository が永続化バックでも
  // 常にインメモリのまま — 再起動をまたいでロックが残留することはない。
  const locks = new Set<string>();

  return {
    remember(projectId: string, sessionId: string, agentId: string): void {
      repository.remember(projectId, sessionId, agentId);
    },

    updateModel(projectId: string, sessionId: string, model: string): void {
      repository.updateModel(projectId, sessionId, model);
    },

    rename(projectId: string, sessionId: string, title: string | null): void {
      repository.rename(projectId, sessionId, title);
    },

    setPinned(projectId: string, sessionId: string, pinned: boolean): void {
      repository.setPinned(projectId, sessionId, pinned);
    },

    lookup(projectId: string, sessionId: string): ChatSessionRecord | undefined {
      return repository.lookup(projectId, sessionId);
    },

    listByProject(projectId: string) {
      return repository.listByProject(projectId);
    },

    forget(projectId: string, sessionId: string): void {
      repository.forget(projectId, sessionId);
    },

    tryAcquire(projectId: string): boolean {
      if (locks.has(projectId)) {
        return false;
      }

      locks.add(projectId);
      return true;
    },

    isBusy(projectId: string): boolean {
      return locks.has(projectId);
    },

    release(projectId: string): void {
      locks.delete(projectId);
    },
  };
}
