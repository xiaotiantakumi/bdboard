// bdboard-sso1.83 第15b段: ChatPanel.tsx のフック配線を controller
// (chat/useChatPanelController.ts)へ移したときの4区間のうち4つ目。
// 元の ChatPanel.tsx 616〜714 行目を行単位でそのまま(コメントごと)移した。
// 呼び出し順は useChatPanelSync → この区間 → ChatPanel の JSX で、元の並びと同じ。
// 前の区間の戻り値は controller が params に spread して渡す。
import { useCallback } from 'react';
import type { ChatQuickCommand } from '../../chatQuickCommands';
import type { ChatPanelControllerParams } from './chatPanelTypes';
import type { ChatPanelAgentAndLauncher } from './useChatPanelAgentAndLauncher';
import type { ChatPanelStores } from './useChatPanelStores';
import type { ChatPanelSync } from './useChatPanelSync';
import { useChatSendCommits } from './useChatSendCommits';
import { useChatSubmit } from './useChatSubmit';
import { useStickToBottomScroll } from './useStickToBottomScroll';

type UseChatPanelComposerParams = ChatPanelControllerParams &
  ChatPanelStores &
  ChatPanelAgentAndLauncher &
  ChatPanelSync;

/**
 * 入力欄まわり: 表示中のストリーミングテキスト、配信停止の回収中フラグ(render 中に ref を
 * 読む。useMemo にしない)、E14/E15(useStickToBottomScroll)、送信の確定処理
 * (useChatSendCommits)、送信(useChatSubmit)、クイックコマンド。
 */
export function useChatPanelComposer(params: UseChatPanelComposerParams) {
  const {
    messagesRef, inputRef, selectedProjectId, setConversations, setHistoryLoadedFor,
    setThreadModelIds, setSelectedThreadIds, currentSessionId, currentConversationKey,
    conversations, send, isSending, streamingReply, detachedStreamSendRef, setThreadLists,
    setOpenThreadIds, conversationInputsRef, conversationAttachmentsRef, setInput,
    updateConversationAttachments, setAttachmentError, applyQuickCommandPrompt, selectedAgentId,
    selectedAgent, selectedAgentUnavailable, showModelSelect, effectiveModelId, currentInput,
    currentAttachments, currentMessages, isHistoryPending, resetBackgroundTurnStatus,
  } = params;
  // 表示中の会話にだけ効くストリーミングテキスト。他の会話のストリームで
  // この会話をスクロールしない。streamingReply は会話キーでスコープした Record
  // (bdboard-1qoe) なので、ここは単純な参照になる。
  const activeStreamingText = streamingReply[currentConversationKey] ?? '';

  // bdboard-v3ag: 配信停止(SSE キュー上限超過等)からの turn-status 回収が
  // まだ終わっていない間、同じプロジェクトへの再送を止める。サーバーは
  // プロジェクト単位で同時に1ターンしか受け付けない (isBusy ロック) ため、
  // ここでブロックしなくても再送自体は通常 409 で弾かれるが、409 が返る
  // 前後のタイミング次第では再送がそのまま処理されてしまうことがあり、その
  // 場合 chat/deliverChatSend.ts 冒頭の setStreamingReply((prev) => ({ ...prev, [sendKey]: '' }))
  // が回収中に保持していた部分テキストを即座に空文字で上書きしてしまう
  // (bdboard-v3ag のチケット本文、bdboard-3tw.166 の Opus レビュー由来)。
  //
  // detachedStreamSendRef は ref なので、その変更だけでは再レンダーが起きない
  // が、この ref への書き込み/クリアは必ず同じ同期ブロック内で別の setState
  // (setTurnRecoveryGeneration、setStreamingReply 等、上の checkTurnStatus /
  // chat/deliverChatSend.ts を参照) を伴っており、その setState が再レンダーを
  // 引き起こす。したがって useMemo 等でメモ化せず、毎レンダーでこの ref を
  // 直接読むだけで値が最新に保たれる。加えて、この値は
  // submit(chat/useChatSubmit.ts)自身の冒頭(クリック/Enter 時点)でも同様に ref を直接
  // 読んで判定しており、そちらはそもそも再レンダーに依存しない
  // (setTurnRecoveryGeneration より前に ref へ書き込まれるため、isSending が
  // false に落ちた直後の一瞬の隙間も塞げる)。
  const hasUnresolvedProjectRecovery =
    detachedStreamSendRef.current[selectedProjectId] !== undefined;

  // 「最下部に貼り付いているときだけ追う」スクロール状態を管理する。
  const { onScroll: handleMessagesScroll } = useStickToBottomScroll(
    messagesRef,
    currentConversationKey,
    currentMessages,
    isSending,
    activeStreamingText,
  );

  // bdboard-sso1.83 第2段: ingestImageFiles/handleImagePaste/
  // handleImageFileChange/removeAttachment は
  // useChatAttachmentIngestion.ts (useChatDraftState.ts 経由) へ移した。
  // 以降は handleImagePaste / handleImageFileChange /
  // removeAttachment を呼ぶ。
  const { commitSuccess, commitFailure, appendTranscript } = useChatSendCommits({
    selectedProjectId,
    showModelSelect,
    effectiveModelId,
    setConversations,
    setHistoryLoadedFor,
    setThreadModelIds,
    setThreadLists,
    setOpenThreadIds,
    setSelectedThreadIds,
    conversationInputsRef,
    conversationAttachmentsRef,
    setInput,
    updateConversationAttachments,
  });

  const { handleSubmit } = useChatSubmit({
    context: {
      selectedProjectId,
      currentConversationKey,
      currentSessionId,
      conversations,
      selectedAgentId,
      selectedAgent,
      selectedAgentUnavailable,
      showModelSelect,
      effectiveModelId,
      isHistoryPending,
      currentInput,
      currentAttachments,
    },
    draft: { setInput, updateConversationAttachments, setAttachmentError },
    send,
    commitSuccess,
    commitFailure,
    appendTranscript,
    resetBackgroundTurnStatus,
    inputRef,
  });

  // bdboard-3tw.133: クイックコマンドは常にプリフィル(入力欄に文言を入れて
  // フォーカスするだけ)で、即時送信はしない。誤タップでそのまま送信されて
  // しまうのを避けるため、送信するかはユーザーが送信ボタン/⌘+Enterで判断する。
  const handleQuickCommand = useCallback(
    (command: ChatQuickCommand) => {
      if (isSending || selectedProjectId === '' || isHistoryPending) {
        return;
      }
      applyQuickCommandPrompt(currentConversationKey, command.prompt);
    },
    [
      currentConversationKey,
      isHistoryPending,
      isSending,
      selectedProjectId,
      applyQuickCommandPrompt,
    ],
  );

  return {
    activeStreamingText, hasUnresolvedProjectRecovery, handleMessagesScroll, handleSubmit,
    handleQuickCommand,
  };
}
