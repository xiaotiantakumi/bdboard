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

/**
 * 既存のテスト・呼び出し元向けの一件追加 API。実体は v2 の一覧に保存する。
 *
 * bdboard-7feq: 既定(liveOpen を渡さない)では、永続化済みエントリの activeSessionIds を基点に
 * thread を末尾へ 1 件足す。この基点は永続化の値で、メモリ上の open(openThreadIdsRef)は
 * 見ない。初回訪問(エントリ無し)では E7(chat/useThreadListSync.ts)が全スレッドを
 * メモリ上でだけ開き、永続化には何も書かない(chat/threadViewRestore.ts)ので、基点が
 * 空のまま送信確定・履歴ロードがこれを呼ぶと、メモリは [A,B,C] なのに永続化は [A] に
 * 潰れ、リロードで B と C が黙って閉じられた。
 *
 * liveOpen を渡すと、永続化済みエントリではなくそれを open の基点にする(順序はそのまま。
 * thread.sessionId が含まれていなければ末尾に足す)。メモリと永続化を一致させる呼び出し側
 * (chat/useChatSendCommits.ts の commitSuccess、chat/useChatHistoryLoader.ts)が、そのプロジェクトの
 * open が復元済み(restoredProjectsRef がマーク済み)で live の open が分かるときだけ渡す。
 * 未復元のうちは渡さない: 永続化の方が正本で、live の open は他経路の書き込み分しか
 * 持たないことがある(bdboard-4w2d)。ここで E7 側に永続化を書かせる直し方は採らない —
 * 再訪時に E7 が「離れている間に増えたスレッド」を取り込めなくなる
 * (chat/useThreadListSync.test.tsx の再訪テスト)。ただしこの性質が実際に残るのは、初回訪問で
 * 履歴ロードも送信も無かったとき(チケット起動のドラフト・履歴ロードの失敗・スレッド 0 件)
 * だけ: E7 の直後に走る最初の履歴ロードが、live の open でエントリを丸ごと書くため。
 *
 * bdboard-0206: 未復元のうちに書いたこの 1 件のエントリ(初回訪問の E7 の一覧 fetch が in-flight の間の
 * 送信成功、採用)は、E7 が応答を受けたときに、サーバー一覧と合わせた open で書き直す
 * (chat/useThreadListSync.ts。メモリの open も同じ集合にする)。でないと、メモリは [A,B,C,新] なのに
 * 永続化と open が [新] に潰れる。E7 が書き直すのは、このエントリが仮のエントリ(bdboard-rt6i の provisionalEntryRef。
 * 未復元で最初のエントリを書いた送信・採用が立てる)のときに限る。利用者の明示的な意図(エージェント切替・閉じる・
 * 削除)が書いたエントリは、マーカーが下りているので利用者の記録として正本のまま。
 */
export function writePersistedChatThread(
  projectId: string,
  thread: PersistedChatThread | undefined,
  liveOpen?: readonly string[],
): void {
  if (thread === undefined) {
    writePersistedChatThreadState(projectId, undefined);
    return;
  }
  if (liveOpen !== undefined) {
    const ids = liveOpen.includes(thread.sessionId) ? [...liveOpen] : [...liveOpen, thread.sessionId];
    writePersistedChatThreadState(projectId, { activeSessionIds: ids, selectedSessionId: thread.sessionId });
    return;
  }
  const current = readPersistedChatThreads()[projectId];
  const ids = [...(current?.activeSessionIds ?? [])].filter((id) => id !== thread.sessionId);
  ids.push(thread.sessionId);
  writePersistedChatThreadState(projectId, { activeSessionIds: ids, selectedSessionId: thread.sessionId });
}
