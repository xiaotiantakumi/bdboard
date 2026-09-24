// bdboard-sso1.83 第15b段: ChatPanel.tsx のフック配線を controller
// (chat/useChatPanelController.ts)へ移したときの4区間のうち3つ目。
// 元の ChatPanel.tsx 442〜615 行目を行単位でそのまま(コメントごと)移した。
// 呼び出し順は useChatPanelAgentAndLauncher → この区間 → useChatPanelComposer で、元の並びと同じ。
// 前の区間の戻り値は controller が params に spread して渡す。
import { useEffect } from 'react';
import type { ChatPanelControllerParams } from './chatPanelTypes';
import {
  projectSelectionHint as computeProjectSelectionHint,
  showProjectSelect as computeShowProjectSelect,
} from './projectSelection';
import { useAbortOnConversationChange } from './useAbortOnConversationChange';
import { useAgentFromConversationSync } from './useAgentFromConversationSync';
import { useAgentListAndModelRestore } from './useAgentListAndModelRestore';
import { useChatHistoryLoader } from './useChatHistoryLoader';
import type { ChatPanelAgentAndLauncher } from './useChatPanelAgentAndLauncher';
import type { ChatPanelStores } from './useChatPanelStores';
import { useChatSessionLifecycle } from './useChatSessionLifecycle';
import { useColdKeyspaceAdoption } from './useColdKeyspaceAdoption';
import { useThreadListSync } from './useThreadListSync';
import { useTicketContextLaunch } from './useTicketContextLaunch';
import { useTurnStatusRecovery } from './useTurnStatusRecovery';

export type UseChatPanelSyncParams = ChatPanelControllerParams &
  ChatPanelStores &
  ChatPanelAgentAndLauncher;

/**
 * 表示用の派生値と、設計書 §1c の E3〜E13(会話からのエージェント同期、会話切替での
 * abort、onProjectIdChange の通知、コールドキースペースの移送、スレッド一覧、
 * turn-status 回収、ticket-context、エージェント一覧とモデル復元、履歴ローダー)を
 * 元の順で呼ぶ。
 */
export function useChatPanelSync(params: UseChatPanelSyncParams) {
  const {
    projects, initialProjectId, initialInput, ticketContextToken, onProjectIdChange, inputRef,
    selectedProjectId, setSelectedProjectId, conversations, setConversations, conversationsRef,
    historyLoadedFor, setHistoryLoadedFor, setLoadingHistoryFor, threadModelIds, setThreadModelIds,
    threadModelIdsRef, historyRequestIdRef, threadListRequestIdRef, setSelectedThreadIds,
    selectedThreadIdsRef, setDraftNonces, draftNoncesRef, currentSessionId, currentConversationKey,
    turnRecoveryGeneration, unresolvedSends, clearUnresolvedSend, clearStreamingReplyForKey,
    detachedStreamSendRef, requestAbortControllerRef, cancelThreadConfirmDelete, setThreadError,
    ticketProjectFallbackNotice, setTicketProjectFallbackNotice, setThreadLists, openThreadIds,
    setOpenThreadIds, openThreadIdsRef, openThreads, conversationInputs, conversationAttachments,
    attachmentErrors, conversationInputsRef, conversationAttachmentsRef, draftSeedTextRef, agents,
    setAgents, setSelectedAgentId, selectedAgent, selectedAgentUnavailable, setSelectedModelId,
    chatModelSelections, migrateDraftPayloadKey, purgeDraftPayloadKeys, pendingPrefillRef,
    pendingTicketDraftProjectRef, startNewDraftThread, advanceDraftNonceAfterSessionGone,
  } = params;
  const currentInput = conversationInputs[currentConversationKey] ?? '';
  const currentAttachments = conversationAttachments[currentConversationKey] ?? [];
  const currentAttachmentError = attachmentErrors[currentConversationKey] ?? null;
  // bdboard-pbf: 既存スレッド選択中で履歴がまだ解決していない間は送信を
  // ブロックする(送信ボタン disabled + chat/useChatSubmit.ts の submit 冒頭ガード)。この窓で
  // 送信すると conversations[key] が未定義のため sessionId 無しで POST され、
  // 既存スレッドの続きではなく別のサーバーセッションにフォークしてしまう。
  // loadingHistoryFor でなく historyLoadedFor を見るのは、履歴 effect が発火する
  // 前の1フレームも覆うため。履歴 fetch は成功/失敗どちらでも finally で
  // historyLoadedFor[key]=true を立てるので、永久にロックされることはない。
  const isHistoryPending =
    currentSessionId !== undefined &&
    historyLoadedFor[currentConversationKey] !== true;
  const currentMessages = conversations[currentConversationKey]?.messages ?? [];
  const selectedProject = projects.find(
    (project) => project.id === selectedProjectId,
  );
  // bdboard-sso1.83 第4段: showProjectSelect/projectSelectionHint の本体は
  // chat/projectSelection.ts へ移した(挙動は変えていない)。
  const showProjectSelect = computeShowProjectSelect(projects, selectedProjectId);
  const projectSelectionHint = computeProjectSelectionHint(projects, selectedProjectId);
  const projectSelectionHintId =
    projectSelectionHint === null ? null : 'chat-project-unselected-hint';
  const agentUnavailableHintId = selectedAgentUnavailable
    ? 'chat-agent-unavailable-hint'
    : null;
  const hasUnsupportedAttachments =
    currentAttachments.length > 0 && selectedAgent?.supportsImages !== true;

  useAgentFromConversationSync({
    currentSessionId,
    conversations,
    agents,
    setSelectedAgentId,
  });

  useAbortOnConversationChange(requestAbortControllerRef, currentConversationKey);

  useEffect(() => {
    if (selectedProjectId !== '') {
      onProjectIdChange?.(selectedProjectId);
    }
  }, [selectedProjectId, onProjectIdChange]);

  // bdboard-sso1.83 第14c段: '' キースペース(プロジェクト未解決中のドラフト)を
  // 実プロジェクトへ移す adoptProjectFromColdKeyspace と、その2つの入口
  // (プロジェクト select の handleProjectSelectChange と、projects 到着時の
  // コールド解決 effect)を chat/useColdKeyspaceAdoption.ts へ抜き出した。
  // effect-order: E6(E5 の後、E7 より前。ticket-context effect(E9)とは
  // ticketContextToken で排他)。
  const { handleProjectSelectChange } = useColdKeyspaceAdoption({
    projects,
    initialProjectId,
    ticketContextToken,
    selectedProjectId,
    setSelectedProjectId,
    draftNoncesRef,
    setDraftNonces,
    conversationInputsRef,
    conversationAttachmentsRef,
    migrateDraftPayloadKey,
    setTicketProjectFallbackNotice,
  });

  // bdboard-sso1.83 第14d段: スレッド一覧 effect(pending の無効化と消化、
  // isExplicitDraftStillSelected、request-id ガード)を chat/useThreadListSync.ts へ
  // 抜き出した。effect-order: E7(E6 の後、E8 の turn-status 回収と E9 の
  // ticket-context effect より前)。
  useThreadListSync({
    selectedProjectId,
    setThreadError,
    pendingPrefillRef,
    pendingTicketDraftProjectRef,
    threadListRequestIdRef,
    draftNoncesRef,
    selectedThreadIdsRef,
    setThreadLists,
    setOpenThreadIds,
    setSelectedThreadIds,
    startNewDraftThread,
  });

  // bdboard-sso1.83 第15a段: applyRecoveredTurn(E8 の hydrate)・
  // handleHistorySessionGone(E12 の 23u prune)・handleResumeDiscoveredSession
  // (CLI セッションの再開)を chat/useChatSessionLifecycle.ts へ move-only で
  // 抜き出した。effect は持たない。applyRecoveredTurn の元の位置(E7 の後、E8 の前)で
  // 呼ぶので、handleHistorySessionGone の useCallback だけが E8〜E11 より前へ移る
  // (effect の登録順は変わらない)。
  const { applyRecoveredTurn, handleHistorySessionGone, handleResumeDiscoveredSession } =
    useChatSessionLifecycle({
      selectedProjectId,
      selectedThreadIdsRef,
      setSelectedThreadIds,
      historyRequestIdRef,
      setConversations,
      setHistoryLoadedFor,
      setLoadingHistoryFor,
      setThreadModelIds,
      openThreads,
      openThreadIdsRef,
      setThreadLists,
      setOpenThreadIds,
      setSelectedAgentId,
      cancelThreadConfirmDelete,
      advanceDraftNonceAfterSessionGone,
    });

  const { backgroundTurnStatus, backgroundTurnProjectId, resetBackgroundTurnStatus } = useTurnStatusRecovery({
    selectedProjectId,
    generation: turnRecoveryGeneration,
    detachedSendsRef: detachedStreamSendRef,
    historyRequestIdRef,
    threadListRequestIdRef,
    setLoadingHistoryFor,
    clearStreamingReplyForKey,
    clearUnresolvedSend,
    applyRecoveredTurn,
  });

  // bdboard-sso1.83 第14e段: ticket-context effect(と appliedTicketContextTokenRef)を
  // chat/useTicketContextLaunch.ts へ抜き出した。依存配列と eslint-disable は元のまま。
  // effect-order: E9(E7 のスレッド一覧 effect と E8 の turn-status 回収の後、
  // useAgentListAndModelRestore の前)。
  useTicketContextLaunch({
    ticketContextToken,
    projects,
    initialProjectId,
    initialInput,
    selectedProjectId,
    setSelectedProjectId,
    inputRef,
    ticketProjectFallbackNotice,
    setTicketProjectFallbackNotice,
    draftNoncesRef,
    conversationInputsRef,
    conversationAttachmentsRef,
    draftSeedTextRef,
    threadModelIdsRef,
    purgeDraftPayloadKeys,
    pendingPrefillRef,
    pendingTicketDraftProjectRef,
    openThreadIds,
    startNewDraftThread,
  });

  useAgentListAndModelRestore({
    selectedAgent,
    selectedProjectId,
    currentConversationKey,
    threadModelIds,
    chatModelSelections,
    setAgents,
    setSelectedAgentId,
    setSelectedModelId,
  });

  useChatHistoryLoader({
    selectedProjectId,
    currentConversationKey,
    currentSessionId,
    conversations,
    historyLoadedFor,
    setConversations,
    setHistoryLoadedFor,
    setLoadingHistoryFor,
    setThreadModelIds,
    historyRequestIdRef,
    conversationsRef,
    setSelectedAgentId,
    unresolvedSends,
    clearUnresolvedSend,
    onSessionGone: handleHistorySessionGone,
  });


  return {
    currentInput, currentAttachments, currentAttachmentError, isHistoryPending, currentMessages,
    selectedProject, showProjectSelect, projectSelectionHint, projectSelectionHintId,
    agentUnavailableHintId, hasUnsupportedAttachments, handleProjectSelectChange,
    handleResumeDiscoveredSession, backgroundTurnStatus, backgroundTurnProjectId,
    resetBackgroundTurnStatus,
  };
}

export type ChatPanelSync = ReturnType<typeof useChatPanelSync>;
