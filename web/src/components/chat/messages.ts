import type { ChatMessageResponseDto, ChatSessionMessageDto, SessionTailMessageDto } from '../../api';
import type { ChatMessageImage } from './attachments';

export type ChatMessage = {
  role: 'user' | 'assistant' | 'error';
  text: string;
  at: number;
  /** このターンで実行できなかった bd ツール呼び出しの名前(bdboard-l1t.4 MF3)。 */
  failedTools?: string[];
  /** ターンは成功したが運用者に知らせるべきエージェント側の警告(bdboard-l1t.6 N-e)。 */
  agentWarnings?: string[];
  /** 画像バイナリは履歴 API に残らないため、このマウント中だけ表示する preview。 */
  images?: ChatMessageImage[];
};

// bdboard-sso1.83 第4段: turn-status 回収(E8)・履歴 fetch(E12)・未回収の取り直し
// (E13) の3箇所に同じ変換(l1t.6 の failedTools/agentWarnings 条件付き spread を
// 含む)が重複していたのを1つに寄せた。3箇所とも本体は完全一致だったので、寄せる
// ことによる挙動の差分は無い。
export function toChatMessages(dtos: readonly ChatSessionMessageDto[]): ChatMessage[] {
  return dtos.map((message) => ({
    role: message.role,
    text: message.content,
    at: Date.parse(message.createdAt),
    ...(message.failedTools !== undefined && message.failedTools.length > 0
      ? { failedTools: message.failedTools }
      : {}),
    ...(message.agentWarnings !== undefined && message.agentWarnings.length > 0
      ? { agentWarnings: message.agentWarnings }
      : {}),
  }));
}

// bdboard-sso1.83 第4段: commitSuccess(旧 applyChatSuccess)が組み立てるアシスタント発話1件分の変換。
// at は呼び出し元(commitSuccess)が Date.now() を渡す — サーバーの createdAt を
// 使わない元の挙動のまま。
export function toAssistantMessage(
  result: ChatMessageResponseDto,
  at: number,
): ChatMessage {
  return {
    role: 'assistant',
    text: result.reply,
    at,
    ...(result.failedTools !== undefined && result.failedTools.length > 0
      ? { failedTools: result.failedTools }
      : {}),
    ...(result.agentWarnings !== undefined && result.agentWarnings.length > 0
      ? { agentWarnings: result.agentWarnings }
      : {}),
  };
}

// CLI セッション採用(handleResumeDiscoveredSession、chat/useChatSessionLifecycle.ts)が会話の
// 初期表示に使う、採用レスポンスの seedMessages 変換。取れる会話が無ければ説明メッセージ 1 行に
// フォールバックする。timestamp が無いメッセージは Date.now() + index で並び順だけ保つ。
// bdboard-z9mn: useChatSessionLifecycle.ts が行数上限(max-lines 200)に達したため、本体から
// 挙動を変えずに移しただけ。
export function toAdoptionSeedMessages(seedMessages: readonly SessionTailMessageDto[]): ChatMessage[] {
  if (seedMessages.length === 0) {
    return [
      {
        role: 'assistant',
        text: 'このCLIセッションの直近の会話をここに表示できませんでした。続きから会話できます。',
        at: Date.now(),
      },
    ];
  }
  return seedMessages.map((message, index) => ({
    role: message.role,
    text: message.text,
    at: message.timestamp !== undefined ? Date.parse(message.timestamp) : Date.now() + index,
  }));
}
