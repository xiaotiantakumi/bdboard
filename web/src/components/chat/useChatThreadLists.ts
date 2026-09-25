import {
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import {
  deleteChatThread,
  updateChatThread,
  type ChatThreadDto,
} from '../../api';
import { writePersistedChatThreadState } from '../../chatThreadStorage';
import { compareThreadsNewestFirst } from './threads';

export interface UseChatThreadListsDrawerActions {
  selectThread: () => void;
  cancelInteractionsForSession: (sessionId: string) => void;
  cancelConfirmDelete: () => void;
  cancelRename: () => void;
  closeDrawer: () => void;
}

export interface UseChatThreadListsParams {
  selectedProjectId: string;
  currentSessionId: string | undefined;
  setSelectedThreadIds: Dispatch<SetStateAction<Record<string, string | undefined>>>;
  setThreadError: (message: string | null) => void;
  renameDraft: string;
  drawer: UseChatThreadListsDrawerActions;
}

export interface UseChatThreadListsResult {
  threadLists: Record<string, ChatThreadDto[]>;
  setThreadLists: Dispatch<SetStateAction<Record<string, ChatThreadDto[]>>>;
  openThreadIds: Record<string, string[]>;
  setOpenThreadIds: Dispatch<SetStateAction<Record<string, string[]>>>;
  openThreadIdsRef: MutableRefObject<Record<string, string[]>>;
  /**
   * bdboard-4w2d: プロジェクトごとに「一覧・open
   * の初回復元(永続化からの復元、または回収の hydrate
   * による復元)を、E7(chat/useThreadListSync.ts)と
   * applyRecoveredTurn(chat/useChatSessionLifecycle.ts)のどちらかが
   * 既に行ったか」を示すマーカー。以前は
   * openThreadIdsRef.current[projectId] === undefined
   * を「未復元」の代理にしていたが、初回一覧の読込中に
   * useChatSendCommits.ts の送信成功や handleAgentChange
   * が先に openThreadIds[projectId] を作ると、この代理が
   * 誤って「復元済み」と判定し、永続化済みの open
   * スレッドを取りこぼして上書きしてしまっていた。
   * このマーカーは「一覧を実際に復元する処理を1回でも
   * 通したか」だけを表し、openThreadIds の中身の有無では
   * 推測しない。
   */
  restoredProjectsRef: MutableRefObject<Set<string>>;
  openThreads: string[];
  threadById: Map<string, ChatThreadDto>;
  displayedOpenThreads: string[];
  closedThreads: ChatThreadDto[];
  hasClosedThreads: boolean;
  currentThreadTitle: string;
  closeThread: (sessionId: string) => void;
  selectOpenThread: (sessionId: string) => void;
  reopenClosedThread: (sessionId: string) => void;
  deleteThread: (sessionId: string) => Promise<void>;
  renameThread: (sessionId: string) => Promise<void>;
  togglePin: (sessionId: string, pinned: boolean) => Promise<void>;
}

/**
 * bdboard-sso1.83 第10段: ChatPanel.tsx から「スレッド一覧(threadLists/
 * openThreadIds)の state と、開閉・選択・削除・リネーム・ピン留めの各操作」を
 * move-only で抜き出したもの。effect は持たない — スレッド一覧の fetch effect
 * (E7)自体は会話キー再割り当てクラスタ(第14段、bdboard-c1pw 領域)の第14d段で
 * chat/useThreadListSync.ts へ移した(このフックの対象外)。ここに残る/移した関数はどれも
 * 「今ある state を書き換えるだけ」の合成ハンドラで、元の読み取り方式
 * (render スコープの値を読む/ref から読む)・updater の内外での副作用呼び出し
 * (S4: writePersistedChatThreadState は setState の updater の外で呼ぶ)は
 * 一切変えていない。
 *
 * closeThread/togglePin は元実装どおり「⋯」メニューを閉じる処理を含まない
 * (呼び出し側の ChatPanel.tsx が threadDrawerRowActions 構築時に
 * closeThreadActionMenu() を先に呼ぶラッパーを保持する)。
 */
export function useChatThreadLists({
  selectedProjectId,
  currentSessionId,
  setSelectedThreadIds,
  setThreadError,
  renameDraft,
  drawer,
}: UseChatThreadListsParams): UseChatThreadListsResult {
  const [threadLists, setThreadLists] = useState<Record<string, ChatThreadDto[]>>({});
  const [openThreadIds, setOpenThreadIds] = useState<Record<string, string[]>>({});

  // bdboard-23u: 404/unknown session 自動回復の catch(履歴フェッチ effect から
  // 呼ばれる chat/useChatSessionLifecycle.ts の handleHistorySessionGone)が、依存配列に openThreadIds を含まないまま
  // writePersistedChatThreadState 用の最新 activeSessionIds を stale closure
  // なしで読むための参照。draftNoncesRef 等と同じミラーパターン。
  const openThreadIdsRef = useRef(openThreadIds);
  openThreadIdsRef.current = openThreadIds;

  // bdboard-4w2d: UseChatThreadListsResult.restoredProjectsRef 参照。
  // プロジェクト単位の Set なので、useRef の初期値はこのフックの
  // 生存期間(ChatPanel 相当のマウント)を通じて1つだけ作られる。
  const restoredProjectsRef = useRef<Set<string>>(new Set());

  const openThreads = openThreadIds[selectedProjectId] ?? [];
  const threadById = new Map(
    (threadLists[selectedProjectId] ?? []).map((thread) => [thread.sessionId, thread]),
  );
  // 開いているスレッドの並びは openThreadIds の挿入順(古いものが先)なので、
  // ここで新しい順に並べ直す。openThreadIds 自体は並べ替えない — あれは
  // 「どのスレッドを開いているか」の永続状態で、表示順とは別物 (bdboard-3tw.154)。
  const displayedOpenThreads = [...openThreads].sort((a, b) =>
    compareThreadsNewestFirst(threadById.get(a), threadById.get(b)),
  );
  // 閉じたスレッドはサーバーが更新の新しい順で返すが、送信直後にローカルで
  // 末尾へ差し込む経路(下の setThreadLists)があるので、表示側でも並べ直して
  // 取得元の順序に依存しないようにしておく。
  const closedThreads = (threadLists[selectedProjectId] ?? [])
    .filter((thread) => !openThreads.includes(thread.sessionId))
    .sort(compareThreadsNewestFirst);
  const hasClosedThreads = closedThreads.length > 0;
  const currentThreadTitle =
    currentSessionId !== undefined
      ? (threadById.get(currentSessionId)?.title ?? '(無題)')
      : '新規';

  const closeThread = (sessionId: string) => {
    const next = openThreads.filter((id) => id !== sessionId);
    const wasSelected = currentSessionId === sessionId;
    // フォールバック先は openThreadIds の挿入順(next[0] = 最古)ではなく、
    // displayedOpenThreads と同じ表示順(新しい順)の先頭に合わせる。3tw.154 で
    // 表示順を挿入順→新しい順に変えたことで、挿入順の先頭のままだと選択が
    // 見た目の最下段へ飛ぶ不整合が生じていた(bdboard-3tw.157)。
    const nextDisplayed = [...next].sort((a, b) =>
      compareThreadsNewestFirst(threadById.get(a), threadById.get(b)),
    );
    const nextSelectedSessionId = wasSelected ? nextDisplayed[0] : currentSessionId;
    setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: next }));
    openThreadIdsRef.current = { ...openThreadIdsRef.current, [selectedProjectId]: next };
    if (wasSelected) {
      setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: nextDisplayed[0] }));
    }
    writePersistedChatThreadState(selectedProjectId, {
      activeSessionIds: next,
      selectedSessionId: nextSelectedSessionId,
    });
    drawer.cancelInteractionsForSession(sessionId);
  };

  const selectOpenThread = (sessionId: string) => {
    drawer.selectThread();
    setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: sessionId }));
    writePersistedChatThreadState(selectedProjectId, {
      activeSessionIds: openThreads,
      selectedSessionId: sessionId,
    });
  };

  const reopenClosedThread = (sessionId: string) => {
    const next = [...openThreads, sessionId];
    setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: next }));
    openThreadIdsRef.current = { ...openThreadIdsRef.current, [selectedProjectId]: next };
    setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: sessionId }));
    writePersistedChatThreadState(selectedProjectId, {
      activeSessionIds: next,
      selectedSessionId: sessionId,
    });
    drawer.closeDrawer();
  };

  const deleteThread = async (sessionId: string) => {
    try {
      await deleteChatThread(sessionId, selectedProjectId);
      closeThread(sessionId);
      setThreadLists((prev) => ({
        ...prev,
        [selectedProjectId]: (prev[selectedProjectId] ?? []).filter(
          (thread) => thread.sessionId !== sessionId,
        ),
      }));
      setThreadError(null);
    } catch (error) {
      console.error('chat thread delete failed', error);
      setThreadError('スレッドの削除に失敗しました。');
    } finally {
      drawer.cancelConfirmDelete();
    }
  };

  const renameThread = async (sessionId: string) => {
    const trimmed = renameDraft.trim();
    const patch = trimmed === '' ? { title: null as string | null } : { title: trimmed };
    try {
      const updated = await updateChatThread(sessionId, selectedProjectId, patch);
      setThreadLists((prev) => ({
        ...prev,
        [selectedProjectId]: (prev[selectedProjectId] ?? []).map((thread) =>
          thread.sessionId === sessionId ? updated : thread,
        ),
      }));
      setThreadError(null);
    } catch (error) {
      console.error('chat thread rename failed', error);
      setThreadError('スレッド名の変更に失敗しました。');
    } finally {
      drawer.cancelRename();
    }
  };

  const togglePin = async (sessionId: string, pinned: boolean) => {
    try {
      const updated = await updateChatThread(sessionId, selectedProjectId, { pinned: !pinned });
      setThreadLists((prev) => ({
        ...prev,
        [selectedProjectId]: (prev[selectedProjectId] ?? []).map((thread) =>
          thread.sessionId === sessionId ? updated : thread,
        ),
      }));
      setThreadError(null);
    } catch (error) {
      console.error('chat thread pin failed', error);
      setThreadError('ピン留めの変更に失敗しました。');
    }
  };

  return {
    threadLists,
    setThreadLists,
    openThreadIds,
    setOpenThreadIds,
    openThreadIdsRef,
    restoredProjectsRef,
    openThreads,
    threadById,
    displayedOpenThreads,
    closedThreads,
    hasClosedThreads,
    currentThreadTitle,
    closeThread,
    selectOpenThread,
    reopenClosedThread,
    deleteThread,
    renameThread,
    togglePin,
  };
}
