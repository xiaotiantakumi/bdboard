import { useRef } from 'react';
import { type ChatThreadDto } from '../api';
import { PlatformLimitationNotice } from './PlatformLimitationNotice';
import { SidePanelResizeHandle } from '../hooks/useResizableSidePanel';
import {
  chatSettingsSummaryParts as computeChatSettingsSummaryParts,
  partitionThreadDrawerRows,
} from './chat/threads';
export { formatThreadUpdatedAt } from './chat/threads';
import { ChatThreadDrawer } from './chat/ChatThreadDrawer';
import { ChatThreadDrawerOpenRow, type ThreadDrawerRowActions } from './chat/ChatThreadDrawerOpenRow';
import { ChatThreadDrawerClosedRow } from './chat/ChatThreadDrawerClosedRow';
import { ChatSettingsPanel } from './chat/ChatSettingsPanel';
import { ChatMessageList } from './chat/ChatMessageList';
import { ChatProjectBar } from './chat/ChatProjectBar';
import { ChatThreadSwitcher } from './chat/ChatThreadSwitcher';
import { ChatComposer } from './chat/ChatComposer';
import { ChatPanelHeader } from './chat/ChatPanelHeader';
import { computeSubmitDisabled, joinDescribedBy } from './chat/composerState';
import type { ChatPanelProps } from './chat/chatPanelTypes';
import { useChatPanelController } from './chat/useChatPanelController';

export function ChatPanel(props: ChatPanelProps) {
  const { projects, isTicketOnBoard, onOpenTicket } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const threadDrawerRef = useRef<HTMLDivElement>(null);
  const threadDrawerCloseButtonRef = useRef<HTMLButtonElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // bdboard-sso1.83 第15b段: JSX より前のフック配線(元の 99〜714 行目)は
  // chat/useChatPanelController.ts(と4つの区間フック)へ移した。フックの呼び出し順は
  // 上の useRef 群 → controller の中の元の並び、で変わらない。DOM の ref はここで作って
  // 渡すだけで、controller の戻り値には含めない(chat/chatPanelTypes.ts 参照)。
  const {
    requestClose, chatPanel, isChatPanelMaximized, setIsChatPanelMaximized, showProjectSelect,
    selectedProjectId, isSending, projectSelectionHintId, handleProjectSelectChange,
    selectedProject, projectSelectionHint, ticketProjectFallbackNotice, threadDrawerOpen,
    toggleThreadDrawer, currentThreadTitle, openThreads, closeThreadDrawer, handleNewThread,
    displayedOpenThreads, hasClosedThreads, showDiscoveredSessions, toggleShowDiscoveredSessions,
    closeShowDiscoveredSessions, handleResumeDiscoveredSession, threadError, agents,
    selectedAgentId, handleAgentChange, selectedAgent, showModelSelect, effectiveModelId,
    handleModelChange, handleMessagesScroll, currentMessages, currentConversationKey,
    loadingHistoryFor, backgroundTurnProjectId, backgroundTurnStatus, activeStreamingText,
    sendElapsedSeconds, currentInput, chatUnsupported, setInput, handleImagePaste,
    handleComposedEnterSubmit, handleSubmit, currentAttachments, isHistoryPending,
    handleQuickCommand, hasUnresolvedProjectRecovery, removeAttachment, currentAttachmentError,
    hasUnsupportedAttachments, selectedAgentUnavailable, agentUnavailableHintId,
    handleImageFileChange, threadById, closedThreads, selectOpenThread, reopenClosedThread,
    setRenameDraft, handleRenameConfirm, cancelThreadRename, toggleThreadActionMenu,
    startThreadRename, closeThreadActionMenu, handlePinToggle, handleCloseThread,
    startThreadConfirmDelete, handleDeleteThread, currentSessionId, renamingSessionId, renameDraft,
    threadActionMenuSessionId, confirmingDeleteSessionId,
  } = useChatPanelController({
    ...props,
    panelRef,
    closeButtonRef,
    threadDrawerRef,
    threadDrawerCloseButtonRef,
    messagesRef,
    inputRef,
    formRef,
  });

  // bdboard-sso1.83 第10段: openThreads/threadById/displayedOpenThreads/
  // closedThreads/hasClosedThreads と、closeThread(= handleCloseThread)/
  // deleteThread/renameThread/togglePin/currentThreadTitle は chat/useChatThreadLists.ts、
  // handleResumeDiscoveredSession は chat/useChatSessionLifecycle.ts(第15a段)にあり、
  // controller(第15b段)経由で上の分割代入で受け取る。
  // bdboard-sso1.83 第4段: 本体は chat/threads.ts へ移した(挙動は変えていない)。
  const chatSettingsSummaryParts = computeChatSettingsSummaryParts(
    selectedProject?.name,
    currentThreadTitle,
    selectedAgent?.label,
  );

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

  return (
    <div className="overlay" onClick={requestClose} role="presentation">
      <div
        ref={panelRef}
        className={`detail-panel chat-panel resizable-side-panel${chatPanel.isResizing ? ' is-resizing' : ''}${isChatPanelMaximized ? ' is-maximized' : ''}`}
        style={{ width: isChatPanelMaximized ? '100%' : `${chatPanel.width}px` }}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-panel-title"
      >
        {!isChatPanelMaximized && (
          <SidePanelResizeHandle label="チャットパネルの幅を変更" panel={chatPanel} />
        )}
        <ChatPanelHeader
          isMaximized={isChatPanelMaximized}
          onToggleMaximize={() => setIsChatPanelMaximized((maximized) => !maximized)}
          closeButtonRef={closeButtonRef}
          onClose={requestClose}
        />

        <ChatProjectBar
          showProjectSelect={showProjectSelect}
          selectedProjectId={selectedProjectId}
          isSending={isSending}
          projectSelectionHintId={projectSelectionHintId}
          onProjectSelectChange={handleProjectSelectChange}
          projects={projects}
          selectedProjectName={selectedProject?.name}
          projectSelectionHint={projectSelectionHint}
          ticketProjectFallbackNotice={ticketProjectFallbackNotice}
        />

        <ChatThreadSwitcher
          threadDrawerOpen={threadDrawerOpen}
          onToggleDrawer={toggleThreadDrawer}
          currentThreadTitle={currentThreadTitle}
          openThreadsCount={openThreads.length}
          onNewThread={() => {
            closeThreadDrawer();
            handleNewThread();
          }}
          hasNoDisplayedOpenThreads={displayedOpenThreads.length === 0}
          hasClosedThreads={hasClosedThreads}
        />
        <ChatThreadDrawer
          open={threadDrawerOpen}
          drawerRef={threadDrawerRef}
          closeButtonRef={threadDrawerCloseButtonRef}
          onClose={closeThreadDrawer}
          hasPinnedRows={pinnedThreadDrawerRows.length > 0}
          pinnedRows={pinnedThreadDrawerRows}
          hasOpenRows={openThreadDrawerRows.length > 0}
          openRows={openThreadDrawerRows}
          hasVisibleClosedThreads={hasVisibleClosedThreads}
          closedRows={closedThreadDrawerRows}
          selectedProjectId={selectedProjectId}
          showDiscoveredSessions={showDiscoveredSessions}
          onToggleDiscoveredSessions={toggleShowDiscoveredSessions}
          isSending={isSending}
          onCloseDiscoveredSessions={closeShowDiscoveredSessions}
          onResumeDiscoveredSession={(sessionId, agentId, seedMessages) => {
            handleResumeDiscoveredSession(sessionId, agentId, seedMessages);
            closeThreadDrawer();
          }}
        />

        <ChatSettingsPanel
          summaryParts={chatSettingsSummaryParts}
          threadError={threadError}
          agents={agents}
          selectedAgentId={selectedAgentId}
          isSending={isSending}
          onAgentChange={handleAgentChange}
          selectedAgent={selectedAgent}
          showModelSelect={showModelSelect}
          effectiveModelId={effectiveModelId}
          onModelChange={handleModelChange}
        />

        {/* 送信して初めて 501 に気付く、では遅い (bdboard-70z.9)。 */}
        <PlatformLimitationNotice feature="chat" />

        <ChatMessageList
          messagesRef={messagesRef}
          onScroll={handleMessagesScroll}
          currentMessages={currentMessages}
          currentConversationKey={currentConversationKey}
          loadingHistoryFor={loadingHistoryFor}
          isSending={isSending}
          backgroundTurnProjectId={backgroundTurnProjectId}
          selectedProjectId={selectedProjectId}
          backgroundTurnStatus={backgroundTurnStatus}
          isTicketOnBoard={isTicketOnBoard}
          onOpenTicket={onOpenTicket}
          activeStreamingText={activeStreamingText}
          sendElapsedSeconds={sendElapsedSeconds}
        />

        <ChatComposer
          formRef={formRef}
          inputRef={inputRef}
          value={currentInput}
          disabled={isSending || chatUnsupported}
          onChange={(event) => {
            setInput(currentConversationKey, event.target.value);
          }}
          onPaste={handleImagePaste}
          onKeyDown={handleComposedEnterSubmit}
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          hasAttachments={currentAttachments.length > 0}
          quickCommands={{
            isSending,
            isHistoryPending,
            selectedProjectId,
            onQuickCommand: handleQuickCommand,
          }}
          notices={{
            hasUnresolvedProjectRecovery,
            isSending,
            attachments: currentAttachments,
            onRemoveAttachment: (attachmentId) => removeAttachment(currentConversationKey, attachmentId),
            attachmentError: currentAttachmentError,
            hasUnsupportedAttachments,
            selectedAgentUnavailable,
            agentUnavailableHintId,
          }}
          actions={{
            fileInputRef,
            isSending,
            chatUnsupported,
            onImageFileChange: handleImageFileChange,
            submitDisabled: computeSubmitDisabled({
              selectedProjectId,
              isSending,
              isHistoryPending,
              chatUnsupported,
              selectedAgentUnavailable,
              hasUnsupportedAttachments,
              hasUnresolvedProjectRecovery,
              currentInput,
              attachmentsCount: currentAttachments.length,
            }),
            ariaDescribedBy: joinDescribedBy([projectSelectionHintId, agentUnavailableHintId]),
          }}
        />
      </div>
    </div>
  );
}
