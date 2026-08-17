const CHAT_THREAD_STORAGE_KEY = 'bdboard.chat.thread.v2';

export interface PersistedChatThread {
  readonly sessionId: string;
  readonly agentId: string;
}

export interface PersistedChatThreadState {
  readonly activeSessionIds: readonly string[];
  readonly selectedSessionId?: string;
}

export type PersistedChatThreads = Record<string, PersistedChatThreadState>;

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch { return null; }
}

function isState(value: unknown): value is PersistedChatThreadState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.activeSessionIds) &&
    record.activeSessionIds.every((id) => typeof id === 'string' && id !== '') &&
    (record.selectedSessionId === undefined || typeof record.selectedSessionId === 'string');
}

export function readPersistedChatThreads(): PersistedChatThreads {
  try {
    const raw = getStorage()?.getItem(CHAT_THREAD_STORAGE_KEY);
    if (raw === null || raw === undefined) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: PersistedChatThreads = {};
    for (const [projectId, state] of Object.entries(parsed)) {
      if (isState(state)) result[projectId] = state;
    }
    return result;
  } catch { return {}; }
}

export function writePersistedChatThreadState(
  projectId: string,
  state: PersistedChatThreadState | undefined,
): void {
  try {
    const storage = getStorage();
    if (storage === null) return;
    const current = readPersistedChatThreads();
    if (state === undefined || state.activeSessionIds.length === 0) {
      const { [projectId]: _, ...rest } = current;
      storage.setItem(CHAT_THREAD_STORAGE_KEY, JSON.stringify(rest));
      return;
    }
    storage.setItem(CHAT_THREAD_STORAGE_KEY, JSON.stringify({ ...current, [projectId]: state }));
  } catch { /* localStorage unavailable */ }
}

// 既存のテスト・呼び出し元向けの一件追加 API。実体は v2 の一覧に保存する。
export function writePersistedChatThread(
  projectId: string,
  thread: PersistedChatThread | undefined,
): void {
  if (thread === undefined) {
    writePersistedChatThreadState(projectId, undefined);
    return;
  }
  const current = readPersistedChatThreads()[projectId];
  const ids = [...(current?.activeSessionIds ?? [])].filter((id) => id !== thread.sessionId);
  ids.push(thread.sessionId);
  writePersistedChatThreadState(projectId, { activeSessionIds: ids, selectedSessionId: thread.sessionId });
}
