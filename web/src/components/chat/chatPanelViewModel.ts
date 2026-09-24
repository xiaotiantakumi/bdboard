import type { ComponentProps } from 'react';
import { chatSettingsSummaryParts as computeChatSettingsSummaryParts } from './threads';
import { computeSubmitDisabled, joinDescribedBy } from './composerState';
import { buildThreadDrawerRows } from './chatThreadDrawerRows';
import type { ChatPanelHeader } from './ChatPanelHeader';
import type { ChatProjectBar } from './ChatProjectBar';
import type { ChatThreadSwitcher } from './ChatThreadSwitcher';
import type { ChatThreadDrawer } from './ChatThreadDrawer';
import type { ChatSettingsPanel } from './ChatSettingsPanel';
import type { ChatMessageList } from './ChatMessageList';
import type { ChatComposer } from './ChatComposer';
import type { ChatInputActionsProps } from './ChatInputActions';
import type { ChatPanelProps } from './chatPanelTypes';
import type { ChatPanelController } from './useChatPanelController';

/**
 * ChatPanel.tsx の JSX が子へ渡す props。DOM の ref(closeButtonRef・drawerRef・
 * messagesRef・formRef・inputRef・fileInputRef)は含めない。ref は ChatPanel が作り、
 * JSX で直接渡す(chat/chatPanelTypes.ts の ChatPanelDomRefs と同じ理由)。
 */
export interface ChatPanelViewModel {
  header: Omit<ComponentProps<typeof ChatPanelHeader>, 'closeButtonRef'>;
  projectBar: ComponentProps<typeof ChatProjectBar>;
  threadSwitcher: ComponentProps<typeof ChatThreadSwitcher>;
  threadDrawer: Omit<ComponentProps<typeof ChatThreadDrawer>, 'drawerRef' | 'closeButtonRef'>;
  settings: ComponentProps<typeof ChatSettingsPanel>;
  messageList: Omit<ComponentProps<typeof ChatMessageList>, 'messagesRef'>;
  composer: Omit<ComponentProps<typeof ChatComposer>, 'formRef' | 'inputRef' | 'actions'>;
  composerActions: Omit<ChatInputActionsProps, 'fileInputRef'>;
}

/**
 * bdboard-sso1.83 第15c段: controller(chat/useChatPanelController.ts)の戻り値と
 * ChatPanel の props から、子の presentational コンポーネントへ渡す props を
 * 子ごとのオブジェクト(view model)にまとめる。ChatPanel.tsx の JSX に並んでいた
 * props 渡しとインラインのハンドラを、値も組み合わせもそのまま移したもの。
 * フックではなく、毎レンダー ChatPanel から呼ばれる(インラインのハンドラが
 * 毎レンダー作り直されていたのも元どおり)。ロジックは足さない。
 * controller には ref も入っているが、render 中に呼ばれる関数なので `*Ref.current` は
 * 読まない(設計書 §4a-1。フックではないので react-hooks/refs はここを検査しない)。
 */
export function buildChatPanelViewModel(
  controller: ChatPanelController,
  props: Pick<ChatPanelProps, 'projects' | 'isTicketOnBoard' | 'onOpenTicket'>,
): ChatPanelViewModel {
  const { projects, isTicketOnBoard, onOpenTicket } = props;
  const {
    requestClose, isChatPanelMaximized, setIsChatPanelMaximized, showProjectSelect,
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
    handleImageFileChange,
  } = controller;

  // bdboard-sso1.83 第4段: 本体は chat/threads.ts へ移した(挙動は変えていない)。
  const chatSettingsSummaryParts = computeChatSettingsSummaryParts(
    selectedProject?.name,
    currentThreadTitle,
    selectedAgent?.label,
  );
  const {
    pinnedThreadDrawerRows, openThreadDrawerRows, closedThreadDrawerRows, hasVisibleClosedThreads,
  } = buildThreadDrawerRows(controller);

  return {
    header: {
      isMaximized: isChatPanelMaximized,
      onToggleMaximize: () => setIsChatPanelMaximized((maximized) => !maximized),
      onClose: requestClose,
    },
    projectBar: {
      showProjectSelect,
      selectedProjectId,
      isSending,
      projectSelectionHintId,
      onProjectSelectChange: handleProjectSelectChange,
      projects,
      selectedProjectName: selectedProject?.name,
      projectSelectionHint,
      ticketProjectFallbackNotice,
    },
    threadSwitcher: {
      threadDrawerOpen,
      onToggleDrawer: toggleThreadDrawer,
      currentThreadTitle,
      openThreadsCount: openThreads.length,
      onNewThread: () => {
        closeThreadDrawer();
        handleNewThread();
      },
      hasNoDisplayedOpenThreads: displayedOpenThreads.length === 0,
      hasClosedThreads,
    },
    threadDrawer: {
      open: threadDrawerOpen,
      onClose: closeThreadDrawer,
      hasPinnedRows: pinnedThreadDrawerRows.length > 0,
      pinnedRows: pinnedThreadDrawerRows,
      hasOpenRows: openThreadDrawerRows.length > 0,
      openRows: openThreadDrawerRows,
      hasVisibleClosedThreads,
      closedRows: closedThreadDrawerRows,
      selectedProjectId,
      showDiscoveredSessions,
      onToggleDiscoveredSessions: toggleShowDiscoveredSessions,
      isSending,
      onCloseDiscoveredSessions: closeShowDiscoveredSessions,
      onResumeDiscoveredSession: (sessionId, agentId, seedMessages) => {
        handleResumeDiscoveredSession(sessionId, agentId, seedMessages);
        closeThreadDrawer();
      },
    },
    settings: {
      summaryParts: chatSettingsSummaryParts,
      threadError,
      agents,
      selectedAgentId,
      isSending,
      onAgentChange: handleAgentChange,
      selectedAgent,
      showModelSelect,
      effectiveModelId,
      onModelChange: handleModelChange,
    },
    messageList: {
      onScroll: handleMessagesScroll,
      currentMessages,
      currentConversationKey,
      loadingHistoryFor,
      isSending,
      backgroundTurnProjectId,
      selectedProjectId,
      backgroundTurnStatus,
      isTicketOnBoard,
      onOpenTicket,
      activeStreamingText,
      sendElapsedSeconds,
    },
    composer: {
      value: currentInput,
      disabled: isSending || chatUnsupported,
      onChange: (event) => {
        setInput(currentConversationKey, event.target.value);
      },
      onPaste: handleImagePaste,
      onKeyDown: handleComposedEnterSubmit,
      onSubmit: (event) => {
        void handleSubmit(event);
      },
      hasAttachments: currentAttachments.length > 0,
      quickCommands: {
        isSending,
        isHistoryPending,
        selectedProjectId,
        onQuickCommand: handleQuickCommand,
      },
      notices: {
        hasUnresolvedProjectRecovery,
        isSending,
        attachments: currentAttachments,
        onRemoveAttachment: (attachmentId) => removeAttachment(currentConversationKey, attachmentId),
        attachmentError: currentAttachmentError,
        hasUnsupportedAttachments,
        selectedAgentUnavailable,
        agentUnavailableHintId,
      },
    },
    composerActions: {
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
    },
  };
}
