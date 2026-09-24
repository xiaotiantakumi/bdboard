// bdboard-sso1.83 第2段: ChatPanel.tsx の「ドラフト本文・添付・添付エラー」3ストアを
// 1つの useReducer に畳んだもの。元は3個の独立した useState
// (conversationInputs / conversationAttachments / attachmentErrors) で、素朴な
// setState の組み合わせ呼び出しをあちこちに書いていた。ここではそのうち
// 「値そのものの読み書き」を明示的な action へ置き換える。挙動は変えない — 各
// action は ChatPanel.tsx 側の元の setter 呼び出し(の組み合わせ)と1対1で対応する。
//
// 会話キーの再割り当て(bdboard-c1pw の対象、ここでは触らない)を行う呼び出し側
// (startNewDraftThread / handleAgentChange / commitFailure の送信失敗時復元 /
// submit の送信時クリア / handleNewThread)のうち、新キーの値を
// 「旧キーの直前の値」から合成する必要がある箇所(handleAgentChange の本文
// 引き継ぎ)だけは 'replace-inputs' 経由の updater(元の
// setConversationInputs(prev => ...) をそのまま dispatch に載せ替えたもの)を
// 使う — prev を関数で読むことで同一バッチ内の他の pending な更新も取りこぼ
// さない。他の call site は新しい値が prev に依存しないため 'set-input' /
// 'set-attachment-error' / 'clear-attachment-error' で十分。
// conversationKeyspace.ts の migrateKeyInRecord/purgeKeysInRecord は
// 'replace-inputs' / 'replace-attachments' / 'replace-attachment-errors' の
// 3つの汎用 action を通る(useChatDraftState.ts の draftApplicators 参照)。
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
  // 旧: handleAgentChange(引き継ぎ、新キーの値を旧キーの直前の値から合成)が
  // 行っていた setConversationInputs(updater) 呼び出し。新しい値が prev に
  // 依存しない他の再割り当てサイト(startNewDraftThread / commitFailure の
  // 送信失敗時復元 / submit の送信時クリア)は 'set-input' で足りる
  // ため、こちらは使わない。conversationKeyspace 経由の
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
  const conversationInputs = inputsSlice(state.conversationInputs, action);
  const conversationAttachments = attachmentsSlice(state.conversationAttachments, action);
  const attachmentErrors = attachmentErrorsSlice(state.attachmentErrors, action);
  // opus レビュー(bdboard-sso1.83) nit: 3スライスとも参照が変わらない
  // no-op(例: purgeKeysInRecord が対象キー無しで元の Record をそのまま返す)
  // なら同一の state 参照を返す。旧実装(3個の独立した useState)は setState
  // が前回と同一参照を検知して自動でレンダーをスキップしていたため、この
  // チェックを省くと no-op dispatch でも毎回レンダーが走るようになり、旧
  // 実装より再レンダー回数が増える退行になる。
  if (
    conversationInputs === state.conversationInputs &&
    conversationAttachments === state.conversationAttachments &&
    attachmentErrors === state.attachmentErrors
  ) {
    return state;
  }
  return { conversationInputs, conversationAttachments, attachmentErrors };
}
