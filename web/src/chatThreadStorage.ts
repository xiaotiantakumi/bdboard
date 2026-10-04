const CHAT_THREAD_STORAGE_KEY = 'bdboard.chat.thread.v2';

export interface PersistedChatThread {
  readonly sessionId: string;
  readonly agentId: string;
}

export interface PersistedChatThreadState {
  readonly activeSessionIds: readonly string[];
  readonly selectedSessionId?: string;
  /**
   * bdboard-521p: このエントリが「仮のエントリ」(bdboard-rt6i。chat/provisionalEntry.ts)か。未復元のプロジェクトで
   * 最初の永続化エントリとして書かれた、利用者の開き閉じの記録ではない暫定値のとき true。メモリ上の印は
   * リロードやチャットパネルを閉じる(ChatPanel のアンマウント)で消えるので、同じ印をここにも持たせて次の訪問へ運ぶ。
   * 旧形式のエントリには無い(= 利用者の記録)。下ろすときはキーごと消す(false は書かない)。
   * 書き込み側は渡さなくてよい: writePersistedChatThreadState が既存エントリのこの 2 つを引き継ぎ、
   * 立てる・下ろす・閉じた id を更新するのは下の writePersistedProvisional* だけ。
   */
  readonly provisional?: true;
  /** bdboard-521p: 仮のエントリの間に利用者が閉じた(削除した)スレッドの id(provisionalEntries.closedIds の保存版)。空のときはキーごと無い。 */
  readonly provisionalClosedSessionIds?: readonly string[];
}

export type PersistedChatThreads = Record<string, PersistedChatThreadState>;

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch { return null; }
}

function isSessionIdList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string' && id !== '');
}

function isState(value: unknown): value is PersistedChatThreadState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isSessionIdList(record.activeSessionIds) &&
    (record.selectedSessionId === undefined || typeof record.selectedSessionId === 'string') &&
    (record.provisional === undefined || record.provisional === true) &&
    (record.provisionalClosedSessionIds === undefined || isSessionIdList(record.provisionalClosedSessionIds));
}

/** bdboard-521p: 仮のエントリの印と閉じた id を除いた、開いているスレッドと選択だけの値。 */
function withoutProvisionalFields(state: PersistedChatThreadState): PersistedChatThreadState {
  return state.selectedSessionId === undefined
    ? { activeSessionIds: state.activeSessionIds }
    : { activeSessionIds: state.activeSessionIds, selectedSessionId: state.selectedSessionId };
}

/** bdboard-521p: 仮のエントリの印と閉じた id だけを取り出す(印が無ければ空)。引き継ぎと書き直しに使う。 */
function provisionalFieldsOf(state: PersistedChatThreadState | undefined): Pick<PersistedChatThreadState, 'provisional' | 'provisionalClosedSessionIds'> {
  if (state?.provisional !== true) return {};
  const closed = state.provisionalClosedSessionIds ?? [];
  return closed.length === 0 ? { provisional: true } : { provisional: true, provisionalClosedSessionIds: closed };
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
  putPersistedChatThreadState(projectId, state, true);
}

/** carryProvisional が false のときだけ、書く値の仮のエントリの印を既存のエントリから引き継がない(clearPersistedProvisionalMark 用)。 */
function putPersistedChatThreadState(
  projectId: string,
  state: PersistedChatThreadState | undefined,
  carryProvisional: boolean,
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
    // bdboard-521p: 仮のエントリの印と閉じた id は、呼び出し側が指定しなければ既存のエントリのものを引き継ぐ。
    // 書き込み元(送信成功・閉じる・選択・採用・履歴ロードなど十数か所)が個別に印を持ち回ると書き漏らしてリロードで
    // 印が落ちる。印を下ろすのは settle(clearPersistedProvisionalMark)だけ。
    const next = carryProvisional && state.provisional === undefined
      ? { ...state, ...provisionalFieldsOf(current[projectId]) }
      : state;
    storage.setItem(CHAT_THREAD_STORAGE_KEY, JSON.stringify({ ...current, [projectId]: next }));
  } catch { /* localStorage unavailable */ }
}

/**
 * bdboard-521p: 仮のエントリの印を保存エントリに立てる(chat/provisionalEntry.ts の markIfFirstEntry から)。
 * 印を立てるのは「このプロジェクトに保存エントリがまだ無い」ときの最初の書き込みの直前なので、エントリが無ければ
 * 空の仮のエントリを作る — 直後の writePersistedChatThread*(中身を埋める)が印を引き継ぐ。エントリが既にあれば何もしない
 * (それは利用者の記録か、すでに仮のエントリ)。
 */
export function writePersistedProvisionalMark(projectId: string): void {
  if (readPersistedChatThreads()[projectId] !== undefined) return;
  writePersistedChatThreadState(projectId, { activeSessionIds: [], provisional: true });
}

/**
 * bdboard-521p: 仮のエントリの間に利用者が閉じた id を保存エントリに書く(noteClosed / noteReopened から)。
 * 仮のエントリでないエントリ・エントリが無いプロジェクトには何も書かない。
 */
export function writePersistedProvisionalClosed(projectId: string, closedSessionIds: readonly string[]): void {
  const current = readPersistedChatThreads()[projectId];
  if (current?.provisional !== true) return;
  const base = withoutProvisionalFields(current);
  writePersistedChatThreadState(projectId, closedSessionIds.length === 0
    ? { ...base, provisional: true }
    : { ...base, provisional: true, provisionalClosedSessionIds: [...closedSessionIds] });
}

/**
 * bdboard-521p: 仮のエントリの印と閉じた id を保存エントリから下ろす(settle から)。開いているスレッド・選択はそのまま。
 * 印が無い・エントリが無いときは何も書かない。
 */
export function clearPersistedProvisionalMark(projectId: string): void {
  const current = readPersistedChatThreads()[projectId];
  if (current === undefined || (current.provisional === undefined && current.provisionalClosedSessionIds === undefined)) return;
  // 通常の書き込みは既存の印を引き継ぐので、下ろすときだけ引き継ぎを切って印の無い値で置く。
  putPersistedChatThreadState(projectId, withoutProvisionalFields(current), false);
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
 * 永続化と open が [新] に潰れる。E7 が書き直すのは、このエントリが仮のエントリ(bdboard-rt6i。chat/provisionalEntry.ts の
 * 印を、未復元で最初のエントリを書く送信・採用・履歴ロードなどが立てる)のときに限る。エージェント切替が書いた空のエントリや、
 * 印が無いときの閉じる・削除の書き込みは、利用者の記録として正本のまま。印がある間の閉じる・削除は、閉じた id を覚えて
 * 開く候補から外す。
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
