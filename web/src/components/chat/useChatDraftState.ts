// bdboard-sso1.83 第2段: ChatPanel.tsx の「ドラフト本文・添付・添付エラー」まわりの
// 状態配線とハンドラを抜き出したもの。状態遷移そのものは chatDraftState.ts の
// reducer が持つ。添付の取り込み(paste/ファイル選択/削除)は 200 行制約のため
// useChatAttachmentIngestion.ts へさらに分けている。ここは useReducer を包み、
// 呼び出し側(ChatPanel)が元の setState/ハンドラ呼び出しと1対1で置き換えられる
// 粒度の関数を返す薄い層(useThreadDrawerState.ts と同じパターン)。挙動は
// 変えていない。
//
// 会話キーの再割り当て(bdboard-c1pw の対象、ここでは触らない)を行う呼び出し側
// (startNewDraftThread / handleAgentChange / handleNewThread)は ChatPanel.tsx に残る。
// 送信失敗時復元(commitFailure)は chat/useChatSendCommits.ts、送信時クリア(submit)は
// chat/useChatSubmit.ts にある(第13b段)。
// それらは setInput / updateConversationAttachments / setAttachmentError /
// clearAttachmentError と conversationInputsRef / draftSeedTextRef を、元の
// setState 呼び出しと同じ形のまま呼び出す。
import { type KeyboardEvent, type RefObject, useCallback, useReducer, useRef } from 'react';
import { isImeComposingKeyEvent } from '../../imeGuard';
import { isEmptyList, isEmptyText, isNeverEmpty, type DraftPayloadStoreTransform } from '../conversationKeyspace';
import type { ChatAttachment } from './attachments';
import { chatDraftReducer, createInitialChatDraftState, type ChatDraftState } from './chatDraftState';
import { makeDraftKey } from './draftKey';
import { useChatAttachmentIngestion } from './useChatAttachmentIngestion';

export interface UseChatDraftStateParams {
  initialInput?: string;
  /** マウント時点の selectedProjectId。レンダーごとに再評価するが、実際に
   * 使われるのは(元の実装と同じく)最初のレンダーで走る遅延初期化の中だけ。 */
  selectedProjectId: string;
  currentConversationKey: string;
  currentConversationKeyRef: RefObject<string>;
  isSending: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  formRef: RefObject<HTMLFormElement | null>;
}

export interface UseChatDraftStateResult {
  conversationInputs: Record<string, string>;
  conversationAttachments: Record<string, ChatAttachment[]>;
  attachmentErrors: Record<string, string>;
  conversationInputsRef: RefObject<Record<string, string>>;
  conversationAttachmentsRef: RefObject<Record<string, ChatAttachment[]>>;
  draftSeedTextRef: RefObject<Record<string, string>>;
  setInput: (key: string, value: string) => void;
  updateConversationInputs: (
    updater: (previous: Record<string, string>) => Record<string, string>,
  ) => void;
  updateConversationAttachments: (
    updater: (previous: Record<string, ChatAttachment[]>) => Record<string, ChatAttachment[]>,
  ) => void;
  setAttachmentError: (key: string, message: string) => void;
  clearAttachmentError: (key: string) => void;
  draftApplicators: {
    conversationInputs: (transform: DraftPayloadStoreTransform) => void;
    conversationAttachments: (transform: DraftPayloadStoreTransform) => void;
    attachmentErrors: (transform: DraftPayloadStoreTransform) => void;
    draftSeedText: (transform: DraftPayloadStoreTransform) => void;
  };
  handleImagePaste: ReturnType<typeof useChatAttachmentIngestion>['handleImagePaste'];
  handleImageFileChange: ReturnType<typeof useChatAttachmentIngestion>['handleImageFileChange'];
  removeAttachment: ReturnType<typeof useChatAttachmentIngestion>['removeAttachment'];
  applyQuickCommandPrompt: (key: string, prompt: string) => void;
  handleComposedEnterSubmit: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function useChatDraftState(params: UseChatDraftStateParams): UseChatDraftStateResult {
  const {
    initialInput,
    selectedProjectId,
    currentConversationKey,
    currentConversationKeyRef,
    isSending,
    inputRef,
    formRef,
  } = params;

  // bdboard-dpq / bdboard-ysu: マウント時点(nonce 0)の初期ドラフトシード。
  // draftSeedTextRef は元の値をそのまま、conversationInputs 側はスプレッドした
  // 別オブジェクトを使う — 元実装のコメントどおり、同一参照を共有すると片方が
  // Record を直接 mutate した場合にもう片方まで無自覚に汚染されるため。
  const initialDraftSeed: Record<string, string> =
    initialInput !== undefined && initialInput !== ''
      ? { [makeDraftKey(selectedProjectId, 0)]: initialInput }
      : {};
  const draftSeedTextRef = useRef<Record<string, string>>(initialDraftSeed);
  const [state, dispatch] = useReducer(
    chatDraftReducer,
    initialDraftSeed,
    (seed): ChatDraftState => createInitialChatDraftState({ ...seed }),
  );

  const conversationInputsRef = useRef(state.conversationInputs);
  conversationInputsRef.current = state.conversationInputs;

  const setInput = useCallback((key: string, value: string) => {
    dispatch({ type: 'set-input', key, value });
  }, []);

  // updateConversationAttachments と同じ理由(呼び出し側が prev を関数で読む
  // ことで、同一バッチ内の他の pending な入力更新も取りこぼさずに合成できる)。
  // 会話キー再割り当て(bdboard-c1pw)のうち、引き継ぎ先キーの値を「引き継ぎ元
  // キーの直前の値」から合成する箇所(handleAgentChange など)専用。
  const updateConversationInputs = useCallback(
    (updater: (previous: Record<string, string>) => Record<string, string>) => {
      dispatch({ type: 'replace-inputs', updater });
    },
    [],
  );

  const setAttachmentError = useCallback((key: string, message: string) => {
    dispatch({ type: 'set-attachment-error', key, message });
  }, []);

  const clearAttachmentError = useCallback((key: string) => {
    dispatch({ type: 'clear-attachment-error', key });
  }, []);

  const {
    conversationAttachmentsRef,
    updateConversationAttachments,
    handleImagePaste,
    handleImageFileChange,
    removeAttachment,
  } = useChatAttachmentIngestion(
    { currentConversationKey, currentConversationKeyRef, isSending, dispatch, setAttachmentError },
    state.conversationAttachments,
  );
  // 防御的な毎レンダー再同期(このファイルの他の ref ミラーと同じ習慣)。
  // conversationAttachments への書き込みは全て useChatAttachmentIngestion 内の
  // eager sync 経由なので理論上は不要だが、他の ref と同じく取りこぼしへの
  // 保険として揃えておく。
  conversationAttachmentsRef.current = state.conversationAttachments;

  // bdboard-ru4d/c1pw: conversationKeyspace.ts の会話キー再割り当て(migrate)/
  // 一括破棄(purge)登録簿へ渡す、4ストア分の transform 適用関数。ChatPanel.tsx
  // 側はこれに threadModelIds 分の1関数を足して5ストア分の登録簿を組み立てる
  // (threadModelIds はこのフックの対象外)。
  const draftApplicators = {
    conversationInputs: useCallback((transform: DraftPayloadStoreTransform) => {
      dispatch({ type: 'replace-inputs', updater: (prev) => transform(prev, isEmptyText) });
    }, []),
    conversationAttachments: useCallback(
      (transform: DraftPayloadStoreTransform) => {
        updateConversationAttachments((prev) => transform(prev, isEmptyList));
      },
      [updateConversationAttachments],
    ),
    attachmentErrors: useCallback((transform: DraftPayloadStoreTransform) => {
      dispatch({ type: 'replace-attachment-errors', updater: (prev) => transform(prev, isNeverEmpty) });
    }, []),
    draftSeedText: useCallback((transform: DraftPayloadStoreTransform) => {
      draftSeedTextRef.current = transform(draftSeedTextRef.current, isNeverEmpty);
    }, []),
  };

  // 旧 handleQuickCommand のドラフト書き込み+カーソル移動部分。isSending /
  // selectedProjectId==='' / isHistoryPending のガードは呼び出し側(ChatPanel)
  // に残す — このフックは draft/添付/カーソル位置の関心のみを持つ。
  const applyQuickCommandPrompt = useCallback(
    (key: string, prompt: string) => {
      draftSeedTextRef.current[key] = prompt;
      setInput(key, prompt);
      requestAnimationFrame(() => {
        const textarea = inputRef.current;
        if (textarea === null) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(prompt.length, prompt.length);
      });
    },
    [inputRef, setInput],
  );

  // 旧 handleKeyDown。IME 変換確定の Enter を送信と区別するガードは
  // isImeComposingKeyEvent (imeGuard.ts) に一本化済み。
  const handleComposedEnterSubmit = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        if (isImeComposingKeyEvent(event)) {
          return;
        }
        event.preventDefault();
        formRef.current?.requestSubmit();
      }
    },
    [formRef],
  );

  return {
    conversationInputs: state.conversationInputs,
    conversationAttachments: state.conversationAttachments,
    attachmentErrors: state.attachmentErrors,
    conversationInputsRef,
    conversationAttachmentsRef,
    draftSeedTextRef,
    setInput,
    updateConversationInputs,
    updateConversationAttachments,
    setAttachmentError,
    clearAttachmentError,
    draftApplicators,
    handleImagePaste,
    handleImageFileChange,
    removeAttachment,
    applyQuickCommandPrompt,
    handleComposedEnterSubmit,
  };
}
