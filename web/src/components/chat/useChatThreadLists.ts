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
import { resolvePersistedSelectionAfterClose, writePersistedChatThreadState } from '../../chatThreadStorage';
import { buildThreadById, compareThreadsNewestFirst } from './threads';
import type { UseConversationKeyResult } from './useConversationKey';

export interface UseChatThreadListsDrawerActions {
  selectThread: () => void;
  cancelInteractionsForSession: (sessionId: string) => void;
  cancelConfirmDelete: () => void;
  cancelRename: () => void;
  closeDrawer: () => void;
}

export interface UseChatThreadListsParams
  extends Pick<UseConversationKeyResult, 'selectedThreadIdsRef'> {
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
 *
 * bdboard-197q で上記の move-only 原則に例外を1つ追加: closeThread は
 * setSelectedThreadIds の直後に selectedThreadIdsRef.current も同期するように
 * なった(render-mirror ラグ対策、詳細はその呼び出し箇所のコメント参照)。
 * これに伴い selectedThreadIdsRef が必須パラメータとして増えている。
 * selectOpenThread/reopenClosedThread は同期を追加していない(理由は各定義
 * 直前のコメント参照)。
 *
 * bdboard-ygrg で2つ目の例外: closeThread 内の next/wasSelected の計算を、
 * render スコープの openThreads/currentSessionId ローカルではなく
 * openThreadIdsRef.current/selectedThreadIdsRef.current から読むように
 * 変更した(closeThread が deleteThread の async 継続から呼ばれた場合に
 * stale なクロージャ値で他の並行更新を巻き戻してしまう closure-staleness
 * 対策、詳細はその呼び出し箇所のコメント参照)。currentSessionId への
 * フォールバックは意図的に持たない(フォールバックすると選択軸で同じ
 * staleness バグが再発するため)。
 *
 * bdboard-e5cz で3つ目の例外: ライブ選択が undefined の場合(draft 表示中)に closeThread が
 * 永続化済み選択を消さないよう、chatThreadStorage.ts の resolvePersistedSelectionAfterClose
 * 経由で永続化済み selectedSessionId を引き継ぐ(詳細はその関数直前のコメント参照)。
 */
export function useChatThreadLists({
  selectedProjectId,
  currentSessionId,
  setSelectedThreadIds,
  selectedThreadIdsRef,
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

  // bdboard-dqbz: closeThread の nextDisplayed ソートが render-time の
  // threadById(クロージャ)ではなく最新の thread メタデータ(updatedAt/pinned)を
  // 読めるよう、openThreadIdsRef と同じ render-mirror パターンで threadLists を
  // ミラーする。詳細は closeThread 内の参照箇所のコメント参照。
  const threadListsRef = useRef(threadLists);
  threadListsRef.current = threadLists;

  // bdboard-4w2d: UseChatThreadListsResult.restoredProjectsRef 参照。
  // プロジェクト単位の Set なので、useRef の初期値はこのフックの
  // 生存期間(ChatPanel 相当のマウント)を通じて1つだけ作られる。
  const restoredProjectsRef = useRef<Set<string>>(new Set());

  const openThreads = openThreadIds[selectedProjectId] ?? [];
  const threadById = buildThreadById(threadLists[selectedProjectId] ?? []);
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

  // bdboard-ygrg: deleteThread の async 継続から呼ばれる場合も最新の
  // open/selected state を使えるよう、next と wasSelected は render-mirror
  // refs から読む。選択判定も ref の値だけを使い、render 時の props へフォールバック
  // しない。選択解除後に古い値を復活させ、同じ stale closure バグを選択軸で
  // 再発させるため。
  const closeThread = (sessionId: string) => {
    const liveOpenThreads = openThreadIdsRef.current[selectedProjectId] ?? [];
    const liveSelectedSessionId = selectedThreadIdsRef.current[selectedProjectId];
    const next = liveOpenThreads.filter((id) => id !== sessionId);
    const wasSelected = liveSelectedSessionId === sessionId;
    // フォールバック先は openThreadIds の挿入順(next[0] = 最古)ではなく、
    // displayedOpenThreads と同じ表示順(新しい順)の先頭に合わせる。3tw.154 で
    // 表示順を挿入順→新しい順に変えたことで、挿入順の先頭のままだと選択が
    // 見た目の最下段へ飛ぶ不整合が生じていた(bdboard-3tw.157)。
    // bdboard-dqbz: ここだけは render スコープの threadById ではなく
    // threadListsRef.current から都度組み立てる。closeThread が deleteThread の
    // async 継続として呼ばれた場合、この関数自体は呼ばれた時点の render の
    // クロージャに固定されるが、threadListsRef は全レンダーで共有される可変
    // オブジェクトなので、await の間に threadLists が更新されていても最新の
    // updatedAt/pinned を読める(ygrg で next/wasSelected に適用したのと同じ理由)。
    const liveThreadById = buildThreadById(threadListsRef.current[selectedProjectId] ?? []);
    const nextDisplayed = [...next].sort((a, b) =>
      compareThreadsNewestFirst(liveThreadById.get(a), liveThreadById.get(b)),
    );
    // bdboard-e5cz: liveSelectedSessionId が undefined = draft 表示中(N2
    // draft-rule)。詳細は chatThreadStorage.ts の resolvePersistedSelectionAfterClose
    // 直前のコメント参照。
    const selectedSessionIdToPersist = wasSelected
      ? nextDisplayed[0]
      : liveSelectedSessionId ?? resolvePersistedSelectionAfterClose(selectedProjectId, next, nextDisplayed[0]);
    setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: next }));
    openThreadIdsRef.current = { ...openThreadIdsRef.current, [selectedProjectId]: next };
    if (wasSelected) {
      setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: nextDisplayed[0] }));
      // bdboard-197q: bdboard-d29q/bdboard-d7on と同じ render-mirror の理由で
      // selectedThreadIdsRef も同期する。closeThread は deleteThread の async
      // 継続からも呼ばれるため、他の async resolve (例: applyRecoveredTurn) と
      // 同 tick で競合し得る。
      selectedThreadIdsRef.current = {
        ...selectedThreadIdsRef.current,
        [selectedProjectId]: nextDisplayed[0],
      };
    }
    writePersistedChatThreadState(selectedProjectId, {
      activeSessionIds: next,
      selectedSessionId: selectedSessionIdToPersist,
    });
    drawer.cancelInteractionsForSession(sessionId);
  };

  // bdboard-197q: ここも setSelectedThreadIds の直後で selectedThreadIdsRef
  // を同期していない (closeThread と同じ render-mirror の1レンダー遅延が
  // 理論上ある)。bdboard-197q の調査 (grep + Opus レビューでの追加検証) では
  // このハンドラは onClick から直接呼ばれる同期関数としてしか呼ばれず、
  // promise の継続として呼ばれる経路が無いため、意図的に同期を追加していない。
  // 安全な理由 (React 19 実測、Opus 調査で確認): React 19 は state 更新の
  // ある同期ハンドラの「最初の setState」の時点でレンダーを microtask として
  // キューする。ユーザークリックは空の microtask queue から始まるため、
  // その setState より後にキューされる microtask (他ハンドラの async 継続等)
  // は、既にキュー済みのレンダー(→ ref 再同期)より後に実行され、常に最新の
  // ref を読む。ただしこの保護は「このハンドラが最初の setState より前に
  // 他の microtask を挟まない」という現状のコード形に依存する暗黙の前提で、
  // 将来ここに await 等を追加すると静かに崩れる。selectedThreadIdsRef を
  // 読む新しい async 経路を足す変更をする際は、このハンドラも同期対象に
  // 追加することを検討すること。
  const selectOpenThread = (sessionId: string) => {
    drawer.selectThread();
    setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: sessionId }));
    writePersistedChatThreadState(selectedProjectId, {
      activeSessionIds: openThreads,
      selectedSessionId: sessionId,
    });
  };

  // bdboard-197q: selectOpenThread と同じ理由・同じ保護で selectedThreadIdsRef
  // の同期を意図的に省略している (上のコメント参照)。
  // 別件: このハンドラの next 計算 ([...openThreads, sessionId]) は
  // render-time の openThreads state に依存しており、closeThread と同型の
  // 「async 継続から呼ばれた場合に stale な値を見る」リスクを理論上持つ。
  // bdboard-ygrg で closeThread 側の同型バグ(next/wasSelected の closure
  // staleness)を openThreadIdsRef/selectedThreadIdsRef 参照に修正した際、
  // reopenClosedThread はこの調査で「grep 済み・onClick からの同期呼び出し
  // のみで async 継続として呼ばれる経路が無い」ため対象外にした
  // (evidence-first、実害が無いものは修正しない方針)。将来 reopenClosedThread
  // を async 経路(例: 何らかの確認 API を待ってから reopen する変更)から
  // 呼ぶようになった場合は、closeThread と同じ ref 参照パターンへの修正を
  // 検討すること。
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
