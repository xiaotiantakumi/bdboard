import type { ChatMessageRequest } from '../../api';
import { attachmentsToPayload, type ChatAttachment } from './attachments';
import type { ChatMessage } from './messages';
import type { ChatConversationEntry } from './useChatConversationsState';

// bdboard-sso1.83 第13b段: 送信本体(chat/useChatSubmit.ts の submit)のうち、
// UI の状態から「どの sessionId で・どんな本文で送り、transcript に何を積むか」を
// 決める部分を純関数へ出した。分岐の順番・条件・キーの並びは元の
// submitChatMessage(ChatPanel.tsx)から変えていない。

/**
 * bdboard-pbf: conversations[key] が「まだ無い」(履歴 fetch がエラー等で
 * 会話が復元されていない)ときは選択中スレッドの currentSessionId へ
 * フォールバックし、sessionId 無し POST による別セッションへのフォークを防ぐ。
 * 一方、conversation が「存在するが sessionId が undefined」なのは
 * 'unknown chat session' 等の clearSession で意図的にクリアされた状態なので、
 * そのときはフォールバックせず新規セッションを開始する(従来挙動)。
 * 履歴 fetch の in-flight 中は submit 冒頭の isHistoryPending ガードで送信自体を
 * ブロックしているため、ここに来る「conversation 無し」は fetch 失敗後のみ。
 * 会話のエージェントと選択中のエージェントが食い違うときは、どちらの場合も
 * sessionId を付けない(エージェントを切り替えた後の送信は新しい会話になる)。
 */
export function resolveSendSessionId(
  conversation: ChatConversationEntry | undefined,
  currentSessionId: string | undefined,
  selectedAgentId: string,
): string | undefined {
  const agentMatches =
    selectedAgentId === '' ||
    conversation?.agentId === undefined ||
    conversation.agentId === selectedAgentId;
  return agentMatches
    ? conversation !== undefined
      ? conversation.sessionId
      : currentSessionId
    : undefined;
}

export interface ChatMessageRequestInput {
  projectId: string;
  message: string;
  sessionId: string | undefined;
  selectedAgentId: string;
  showModelSelect: boolean;
  effectiveModelId: string;
  attachments: readonly ChatAttachment[];
}

/**
 * POST 本文を組み立てる。キーは projectId, message, sessionId, agentId, model,
 * images の順に入る(JSON 本文のキー順も元のまま)。添付があるときは
 * attachmentsToPayload が data URL を読めないと throw するので、呼び出し側が
 * catch して添付エラーを出す。
 */
export function buildChatMessageRequest(input: ChatMessageRequestInput): ChatMessageRequest {
  const messagePayload: ChatMessageRequest = {
    projectId: input.projectId,
    message: input.message,
  };
  if (input.sessionId !== undefined) messagePayload.sessionId = input.sessionId;
  if (input.selectedAgentId !== '') messagePayload.agentId = input.selectedAgentId;
  if (input.showModelSelect && input.effectiveModelId !== '') messagePayload.model = input.effectiveModelId;
  if (input.attachments.length > 0) {
    // preview生成時に読み終えたdata URLを再利用する。送信後にFileReaderを
    // 再度待たず、POST開始前の切替でdraftを失う非同期の窓を作らない。
    messagePayload.images = attachmentsToPayload(input.attachments);
  }
  return messagePayload;
}

/**
 * 楽観的に transcript へ積むユーザー発話。at は送信時刻(sentAt)で、送信失敗時に
 * この発話を取り消す目印になる(bdboard-sp2: commitFailure が `at === sentAt` で消す)。
 * 画像は preview だけを持たせる(履歴 API には画像が残らないため)。
 */
export function buildOptimisticUserMessage(
  text: string,
  sentAt: number,
  attachments: readonly ChatAttachment[],
): ChatMessage {
  return {
    role: 'user',
    text,
    at: sentAt,
    ...(attachments.length > 0
      ? {
          images: attachments.map(({ previewUrl, name, size }) => ({
            previewUrl,
            name,
            size,
          })),
        }
      : {}),
  };
}
