import type { ChatThreadDto } from '../../api';
import { partitionThreadDrawerRows } from './threads';
import { ChatThreadDrawerOpenRow, type ThreadDrawerRowActions } from './ChatThreadDrawerOpenRow';
import { ChatThreadDrawerClosedRow } from './ChatThreadDrawerClosedRow';
import type { ChatPanelController } from './useChatPanelController';

type ThreadDrawerRowSource = Pick<
  ChatPanelController,
  | 'displayedOpenThreads' | 'closedThreads' | 'threadById' | 'agents' | 'currentSessionId'
  | 'renamingSessionId' | 'renameDraft' | 'threadActionMenuSessionId' | 'confirmingDeleteSessionId'
  | 'selectOpenThread' | 'reopenClosedThread' | 'setRenameDraft' | 'handleRenameConfirm'
  | 'cancelThreadRename' | 'toggleThreadActionMenu' | 'startThreadRename' | 'closeThreadActionMenu'
  | 'handlePinToggle' | 'handleCloseThread' | 'startThreadConfirmDelete' | 'handleDeleteThread'
>;

/**
 * bdboard-sso1.83 第15c段: スレッド一覧ドロワーの行(ピン留め・開いている・閉じた)を
 * 組み立てる。ChatPanel.tsx にあった行データの計算と行要素の生成を、中身を変えずに
 * 移したもの(フックではない。毎レンダー ChatPanel から呼ばれ、元どおり毎回新しい
 * 要素と actions オブジェクトを作る)。
 */
export function buildThreadDrawerRows(source: ThreadDrawerRowSource) {
  const {
    displayedOpenThreads, closedThreads, threadById, agents, currentSessionId, renamingSessionId,
    renameDraft, threadActionMenuSessionId, confirmingDeleteSessionId, selectOpenThread,
    reopenClosedThread, setRenameDraft, handleRenameConfirm, cancelThreadRename,
    toggleThreadActionMenu, startThreadRename, closeThreadActionMenu, handlePinToggle,
    handleCloseThread, startThreadConfirmDelete, handleDeleteThread,
  } = source;

  // Chat Redesign 1b: スレッド一覧ドロワーの行データ。ピン留め判定(displayedOpenThreads/
  // closedThreads のどちらに属していても「ピン留め」節へ寄せる mutual exclusion)は
  // chat/threads.ts の partitionThreadDrawerRows へ移した(bdboard-sso1.83 第6段。
  // 挙動は変えていない)。
  const {
    pinnedOpen: pinnedOpenSessionIds,
    unpinnedOpen: unpinnedOpenSessionIds,
    pinnedClosed: pinnedClosedThreadList,
    unpinnedClosed: unpinnedClosedThreadList,
  } = partitionThreadDrawerRows(displayedOpenThreads, closedThreads, threadById);
  const hasVisibleClosedThreads = unpinnedClosedThreadList.length > 0;

  // bdboard-sso1.83 第6段: 行の JSX 本体は ChatThreadDrawerOpenRow/
  // ChatThreadDrawerClosedRow(chat/ 配下)へ move-only で抜き出した。ここに残るのは
  // 「⋯」メニューを閉じたうえで本処理(togglePin/closeThread、いずれも
  // chat/useChatThreadLists.ts 由来)を呼ぶラッパーと、行ごとの派生値(agentLabel 等)の
  // 計算だけ。select/reopenClosed 自体(元実装の「複数ステップをまとめたハンドラ」)は
  // bdboard-sso1.83 第10段で chat/useChatThreadLists.ts の selectOpenThread/
  // reopenClosedThread へ move-only で抜き出した。actions オブジェクトは各行
  // コンポーネントへそのまま渡す(元実装と同じく、毎レンダー新しいクロージャを
  // 作るだけで安定参照化はしていない)。
  const threadDrawerRowActions: ThreadDrawerRowActions = {
    select: selectOpenThread,
    reopenClosed: reopenClosedThread,
    changeRenameDraft: setRenameDraft,
    confirmRename: (sessionId) => void handleRenameConfirm(sessionId),
    cancelRename: cancelThreadRename,
    toggleMenu: toggleThreadActionMenu,
    startRename: startThreadRename,
    togglePin: (sessionId, pinned) => {
      closeThreadActionMenu();
      void handlePinToggle(sessionId, pinned);
    },
    closeThread: (sessionId) => {
      closeThreadActionMenu();
      handleCloseThread(sessionId);
    },
    startConfirmDelete: startThreadConfirmDelete,
    deleteThread: (sessionId) => void handleDeleteThread(sessionId),
  };

  const renderThreadDrawerOpenRow = (sessionId: string) => {
    const thread = threadById.get(sessionId);
    const agentLabel = agents.find((agent) => agent.id === thread?.agentId)?.label ?? thread?.agentId;
    return (
      <ChatThreadDrawerOpenRow
        key={sessionId}
        sessionId={sessionId}
        thread={thread}
        agentLabel={agentLabel}
        isSelected={currentSessionId === sessionId}
        isRenaming={renamingSessionId === sessionId}
        renameDraft={renameDraft}
        isMenuOpen={threadActionMenuSessionId === sessionId}
        isConfirmingDelete={confirmingDeleteSessionId === sessionId}
        actions={threadDrawerRowActions}
      />
    );
  };

  const renderThreadDrawerClosedRow = (thread: ChatThreadDto) => (
    <ChatThreadDrawerClosedRow key={thread.sessionId} thread={thread} actions={threadDrawerRowActions} />
  );

  const pinnedThreadDrawerRows = [
    ...pinnedOpenSessionIds.map(renderThreadDrawerOpenRow),
    ...pinnedClosedThreadList.map(renderThreadDrawerClosedRow),
  ];
  const openThreadDrawerRows = unpinnedOpenSessionIds.map(renderThreadDrawerOpenRow);
  const closedThreadDrawerRows = unpinnedClosedThreadList.map(renderThreadDrawerClosedRow);

  return { pinnedThreadDrawerRows, openThreadDrawerRows, closedThreadDrawerRows, hasVisibleClosedThreads };
}
