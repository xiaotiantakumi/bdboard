import { type FormEvent, type RefObject, useCallback } from 'react';
import type { ChatAgentDto, ChatMessageRequest } from '../../api';
import { CHAT_AGENT_UNAVAILABLE_WARNING } from '../../writeAccessMessage';
import { CHAT_IMAGE_ONLY_PROMPT, type ChatAttachment } from './attachments';
import { deliverChatSend } from './deliverChatSend';
import { buildChatMessageRequest, buildOptimisticUserMessage, resolveSendSessionId } from './sendRequest';
import type { ChatConversationEntry } from './useChatConversationsState';
import type { UseChatDraftStateResult } from './useChatDraftState';
import type { UseChatSendCommitsResult } from './useChatSendCommits';
import type { UseChatSendStateResult } from './useChatSendState';

export interface ChatSubmitContext {
  selectedProjectId: string;
  currentConversationKey: string;
  currentSessionId: string | undefined;
  conversations: Record<string, ChatConversationEntry>;
  selectedAgentId: string;
  selectedAgent: ChatAgentDto | undefined;
  selectedAgentUnavailable: boolean;
  showModelSelect: boolean;
  effectiveModelId: string;
  isHistoryPending: boolean;
  currentInput: string;
  currentAttachments: ChatAttachment[];
}

export interface UseChatSubmitParams
  extends Pick<UseChatSendCommitsResult, 'commitSuccess' | 'commitFailure' | 'appendTranscript'> {
  context: ChatSubmitContext;
  draft: Pick<UseChatDraftStateResult, 'setInput' | 'updateConversationAttachments' | 'setAttachmentError'>;
  send: UseChatSendStateResult;
  resetBackgroundTurnStatus: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

export interface UseChatSubmitResult {
  submit: (text: string, sentRawText: string, sentAttachments: readonly ChatAttachment[]) => Promise<void>;
  handleSubmit: (event: FormEvent) => Promise<void>;
}

/**
 * bdboard-sso1.83 第13b段: ChatPanel.tsx の送信本体(旧 submitChatMessage)と
 * フォームの submit ハンドラ(handleSubmit)。effect は持たない(useCallback だけ)。
 * 呼び出し位置は元の submitChatMessage の位置。何を送るかは chat/sendRequest.ts の
 * 純関数、POST とその結果の振り分けは chat/deliverChatSend.ts、結果をストアへ
 * 書く action は chat/useChatSendCommits.ts が持つ。ここに残るのはガード、
 * 楽観的な書き込みと入力欄のクリア、送信中フラグ、controller の後始末と focus。
 */
export function useChatSubmit(params: UseChatSubmitParams): UseChatSubmitResult {
  const {
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
  } = params.context;
  const { setInput, updateConversationAttachments, setAttachmentError } = params.draft;
  const {
    isSending,
    setIsSending,
    setStreamingReply,
    setTurnRecoveryGeneration,
    clearStreamingReplyForKey,
    markUnresolvedSend,
    detachedStreamSendRef,
    requestAbortControllerRef,
  } = params.send;
  const { commitSuccess, commitFailure, appendTranscript, resetBackgroundTurnStatus, inputRef } = params;

  const submit = useCallback(
    async (text: string, sentRawText: string, sentAttachments: readonly ChatAttachment[]) => {
      if (selectedAgentUnavailable) {
        if (text !== '' || sentAttachments.length > 0) {
          appendTranscript(currentConversationKey, {
            role: 'error',
            text: CHAT_AGENT_UNAVAILABLE_WARNING,
            at: Date.now(),
          });
        }
        return;
      }
      // bdboard-v3ag: detachedStreamSendRef を ref のまま直接読む(クリック/
      // Enter 時点の最新値、hasUnresolvedProjectRecovery の定義コメント参照)。
      // isSending は配信停止直後に false へ戻るため、isSending だけのガードでは
      // 回収中の再送を防げない。
      const unresolvedProjectRecoveryAtSubmit =
        detachedStreamSendRef.current[selectedProjectId] !== undefined;
      if (
        (text === '' && sentAttachments.length === 0) ||
        isSending ||
        selectedProjectId === '' ||
        isHistoryPending ||
        unresolvedProjectRecoveryAtSubmit ||
        (sentAttachments.length > 0 && selectedAgent?.supportsImages !== true)
      ) {
        return;
      }

      // bdboard-pbf の sessionId 解決(フォークさせない/clearSession を区別する)は
      // resolveSendSessionId のコメント参照。
      const sessionId = resolveSendSessionId(conversations[currentConversationKey], currentSessionId, selectedAgentId);
      const sentAt = Date.now();
      let payload: ChatMessageRequest;
      try {
        payload = buildChatMessageRequest({
          projectId: selectedProjectId,
          message: text,
          sessionId,
          selectedAgentId,
          showModelSelect,
          effectiveModelId,
          attachments: sentAttachments,
        });
      } catch {
        // 投げうるのは添付の data URL 変換(attachmentsToPayload)だけ。
        setAttachmentError(currentConversationKey, '画像を送信形式に変換できませんでした。');
        return;
      }

      // bdboard-pbf: 解決済みの sessionId を楽観的書き込みの時点で会話に
      // 焼き込む。これが無いと、フォールバック (conversation 未定義 →
      // currentSessionId) で送った 1 回目が transient エラー (409 等) に
      // なったとき、エラーパスが「sessionId 無しの conversation」を作って
      // しまい、リトライ時に clearSession 済みと誤分類されて sessionId 無し
      // POST でフォークする。clearSession 経路ではそもそもローカルの
      // sessionId が undefined なので、この条件付きの焼き込みは挙動を変えない。
      appendTranscript(currentConversationKey, buildOptimisticUserMessage(text, sentAt, sentAttachments), sessionId);
      // 入力欄のクリアは try の前。AbortError では復元しない(commitFailure へ来ない)。
      setInput(currentConversationKey, '');
      updateConversationAttachments((prev) => ({ ...prev, [currentConversationKey]: [] }));
      resetBackgroundTurnStatus();
      setIsSending(true);
      // 送信時点の会話キー。await の後でスレッド/プロジェクトが切り替わっていても、
      // 返信・失敗・部分テキストはこのキーへ書く。
      const sendKey = currentConversationKey;
      const requestController = new AbortController();
      requestAbortControllerRef.current = requestController;

      try {
        await deliverChatSend({
          payload,
          streaming: selectedAgent?.supportsStreaming === true,
          signal: requestController.signal,
          projectId: selectedProjectId,
          sendKey,
          sessionId,
          onSuccess: (result) => commitSuccess(sendKey, text, result),
          onFailure: (error) => commitFailure(sendKey, sentRawText, sentAttachments, error, sentAt),
          send: {
            setStreamingReply,
            setTurnRecoveryGeneration,
            markUnresolvedSend,
            clearStreamingReplyForKey,
            detachedStreamSendRef,
          },
        });
      } catch (error) {
        // Keep the common controller ref from surviving an unexpected adapter failure.
        requestAbortControllerRef.current = null;
        throw error;
      } finally {
        if (requestAbortControllerRef.current === requestController) {
          requestAbortControllerRef.current = null;
        }
        setIsSending(false);
        inputRef.current?.focus();
      }
    },
    [
      selectedAgentUnavailable,
      currentConversationKey,
      currentSessionId,
      conversations,
      selectedProjectId,
      selectedAgentId,
      selectedAgent,
      showModelSelect,
      effectiveModelId,
      isHistoryPending,
      isSending,
      setIsSending,
      setStreamingReply,
      setTurnRecoveryGeneration,
      clearStreamingReplyForKey,
      markUnresolvedSend,
      detachedStreamSendRef,
      requestAbortControllerRef,
      setInput,
      updateConversationAttachments,
      setAttachmentError,
      commitSuccess,
      commitFailure,
      appendTranscript,
      resetBackgroundTurnStatus,
      inputRef,
    ],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const trimmedText = currentInput.trim();
      const text = trimmedText === '' && currentAttachments.length > 0 ? CHAT_IMAGE_ONLY_PROMPT : trimmedText;
      // bdboard-otf Opus レビュー SF2: 送信失敗時の復元(commitFailure)には、
      // この trim 済み text ではなく trim 前の本文を渡す。プリフィル文言は
      // 末尾に半角スペースを含む形式(例: `${ticketId} について: `)が本番で実在し、
      // 復元値が trim 済みだと未編集シード(draftSeedTextRef、末尾スペース込み)と
      // 一致しなくなり、SF1 の「未編集シードの復元は seed 記録を維持する」判定が
      // 壊れる。送信ペイロード自体は従来どおり trim 済み text を使う。
      await submit(text, currentInput, currentAttachments);
    },
    [currentAttachments, currentInput, submit],
  );

  return { submit, handleSubmit };
}
