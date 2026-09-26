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
    // bdboard-ij6e: state が undefined(このプロジェクトの永続化を明示的に
    // クリアする呼び出し、例: writePersistedChatThread(projectId, undefined))と、
    // state.activeSessionIds が空(このプロジェクトで開いているスレッドを
    // 意図的に0件にした呼び出し、例: closeThread が最後の1つを閉じた)は別物。
    // どちらも「削除」に倒すと、後者が前者と区別できなくなり、次回訪問時に
    // threadViewRestore.ts の restoreThreadView が「エントリが無い = 初回訪問」と
    // 誤認して全スレッドを再び開いてしまう(意図的に全部閉じた直後の挙動として
    // 誤り)。削除は state === undefined のときだけ行う。
    if (state === undefined) {
      const { [projectId]: _, ...rest } = current;
      storage.setItem(CHAT_THREAD_STORAGE_KEY, JSON.stringify(rest));
      return;
    }
    storage.setItem(CHAT_THREAD_STORAGE_KEY, JSON.stringify({ ...current, [projectId]: state }));
  } catch { /* localStorage unavailable */ }
}

/**
 * bdboard-e5cz: chat/useChatThreadLists.ts の closeThread は、ライブで選択中の
 * スレッドが無い状態(draft 表示中、N2 draft-rule)でも呼ばれる。そのとき素朴に
 * undefined を永続化すると、draft 表示中に無関係な別スレッドを閉じただけで、
 * 既存の永続化済み選択が消えてしまう(N2 が守ろうとしている「次回訪問時に
 * また同じ既存スレッドへ戻れる」という前提と食い違う)。永続化済みの選択を
 * そのまま引き継ぎつつ、それが next(閉じた後の activeSessionIds として
 * これから永続化する集合)にもう含まれていない場合(=まさに今閉じたスレッド
 * だった等)だけ fallbackSessionId(表示順の先頭)へフォールバックする。
 */
export function resolvePersistedSelectionAfterClose(
  projectId: string,
  next: readonly string[],
  fallbackSessionId: string | undefined,
): string | undefined {
  const persisted = readPersistedChatThreads()[projectId]?.selectedSessionId;
  return persisted !== undefined && next.includes(persisted) ? persisted : fallbackSessionId;
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
