// bdboard-sso1.83 第2段: ChatPanel.tsx の「ドラフト本文・添付・添付エラー」3ストアを
// 1つの useReducer に畳んだもの。元は3個の独立した useState
// (conversationInputs / conversationAttachments / attachmentErrors) で、素朴な
// setState の組み合わせ呼び出しをあちこちに書いていた。ここではそのうち
// 「値そのものの読み書き」を明示的な action へ置き換える。挙動は変えない — 各
// action は ChatPanel.tsx 側の元の setter 呼び出し(の組み合わせ)と1対1で対応する。
//
// 会話キーの再割り当て(bdboard-c1pw の対象、ここでは触らない)を行う呼び出し側
// (startNewDraftThread / handleAgentChange / applyChatError の送信失敗時復元 /
// submitChatMessage の送信時クリア / handleNewThread)は、複数キーをまたいだ
// 任意の Record 変換を必要とするため、それらは 'replace-inputs' /
// 'replace-attachments' / 'replace-attachment-errors' という汎用の updater
// 経由 action(元の setState(updater) 呼び出しをそのまま dispatch に載せ替えた
// だけ)を使う。conversationKeyspace.ts の migrateKeyInRecord/purgeKeysInRecord
// もこの3つの汎用 action を通る(useChatDraftState.ts の draftApplicators 参照)。
import type { ChatAttachment } from './attachments';

export interface ChatDraftState {
  conversationInputs: Record<string, string>;
  conversationAttachments: Record<string, ChatAttachment[]>;
  attachmentErrors: Record<string, string>;
}

export function createInitialChatDraftState(
  initialInputs: Record<string, string>,
): ChatDraftState {
  return {
    conversationInputs: initialInputs,
    conversationAttachments: {},
    attachmentErrors: {},
  };
}

type RecordUpdater<T> = (previous: Record<string, T>) => Record<string, T>;

export type ChatDraftAction =
  // 旧: textarea の onChange、handleQuickCommand の setConversationInputs
  | { type: 'set-input'; key: string; value: string }
  // 旧: startNewDraftThread / applyChatError(送信失敗時の復元) /
  // submitChatMessage(送信時クリア) / handleAgentChange(引き継ぎ) が行っていた
  // setConversationInputs(updater) 呼び出し。conversationKeyspace 経由の
  // migrateKeyInRecord/purgeKeysInRecord もここを通る。
  | { type: 'replace-inputs'; updater: RecordUpdater<string> }
  // 旧: ingestImageFiles 成功時の updateConversationAttachments(追記) +
  // setAttachmentErrors(該当キーの削除) の組み合わせを1 action に統合。
  // 常にペアで呼ばれていたため、統合しても最終状態は変わらない。
  | { type: 'add-attachments'; key: string; items: readonly ChatAttachment[] }
  // 旧: removeAttachment の updateConversationAttachments(id で除外) +
  // setAttachmentErrors(該当キーの削除) の組み合わせを1 action に統合。
  | { type: 'remove-attachment'; key: string; id: string }
  // 旧: startNewDraftThread / handleAgentChange(引き継ぎ) / applyChatError
  // (送信失敗時の復元) / submitChatMessage(送信時クリア) / handleNewThread が
  // 行っていた updateConversationAttachments(updater) 呼び出し。
  | { type: 'replace-attachments'; updater: RecordUpdater<ChatAttachment[]> }
  // 旧: ingestImageFiles のバリデーション失敗 / submitChatMessage の画像変換
  // 失敗が行っていた setAttachmentErrors({...prev, [key]: message})。
  | { type: 'set-attachment-error'; key: string; message: string }
  // 旧: handleNewThread が行っていた setAttachmentErrors(該当キーの削除)。
  | { type: 'clear-attachment-error'; key: string }
  // draftApplicators(conversationKeyspace の migrateKeyInRecord/purgeKeysInRecord)
  // 専用の汎用 updater 経由 action。
  | { type: 'replace-attachment-errors'; updater: RecordUpdater<string> };

function inputsSlice(
  inputs: Record<string, string>,
  action: ChatDraftAction,
): Record<string, string> {
  switch (action.type) {
    case 'set-input':
      return { ...inputs, [action.key]: action.value };
    case 'replace-inputs':
      return action.updater(inputs);
    default:
      return inputs;
  }
}

export function attachmentsSlice(
  attachments: Record<string, ChatAttachment[]>,
  action: ChatDraftAction,
): Record<string, ChatAttachment[]> {
  switch (action.type) {
    case 'add-attachments': {
      const existing = attachments[action.key] ?? [];
      return { ...attachments, [action.key]: [...existing, ...action.items] };
    }
    case 'remove-attachment': {
      const existing = attachments[action.key] ?? [];
      return {
        ...attachments,
        [action.key]: existing.filter((attachment) => attachment.id !== action.id),
      };
    }
    case 'replace-attachments':
      return action.updater(attachments);
    default:
      return attachments;
  }
}

function attachmentErrorsSlice(
  errors: Record<string, string>,
  action: ChatDraftAction,
): Record<string, string> {
  switch (action.type) {
    case 'add-attachments':
    case 'remove-attachment':
    case 'clear-attachment-error': {
      if (!(action.key in errors)) return errors;
      const next = { ...errors };
      delete next[action.key];
      return next;
    }
    case 'set-attachment-error':
      return { ...errors, [action.key]: action.message };
    case 'replace-attachment-errors':
      return action.updater(errors);
    default:
      return errors;
  }
}

export function chatDraftReducer(state: ChatDraftState, action: ChatDraftAction): ChatDraftState {
  return {
    conversationInputs: inputsSlice(state.conversationInputs, action),
    conversationAttachments: attachmentsSlice(state.conversationAttachments, action),
    attachmentErrors: attachmentErrorsSlice(state.attachmentErrors, action),
  };
}
