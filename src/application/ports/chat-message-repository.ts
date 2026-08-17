export type ChatMessageRole = 'user' | 'assistant';

export interface ChatMessageRecord {
  readonly role: ChatMessageRole;
  readonly content: string;
  readonly createdAt: Date;
  readonly failedTools?: readonly string[];
  readonly agentWarnings?: readonly string[];
}

export interface ChatMessageAppendInput {
  readonly role: ChatMessageRole;
  readonly content: string;
  readonly createdAt?: Date;
  readonly failedTools?: readonly string[];
  readonly agentWarnings?: readonly string[];
}

export interface ChatThreadSummary {
  /** 先頭 user メッセージの content の先頭 CHAT_MESSAGE_MAX_LENGTH (4000) コードポイント。送信時の本文上限 (send-chat-message が同じ定数で検証) と同長なので実質全文。user メッセージが無ければ undefined。 */
  readonly firstUserContentPrefix: string | undefined;
  /** そのセッションの最終メッセージの created_at。メッセージが無ければ undefined。 */
  readonly lastMessageAt: Date | undefined;
}

export interface ChatMessageRepository {
  append(sessionId: string, messages: readonly ChatMessageAppendInput[]): void;
  listBySession(sessionId: string): readonly ChatMessageRecord[];
  /**
   * 指定した sessionId 群について、スレッド一覧表示に必要な要約だけを返す。
   */
  listThreadSummaries(sessionIds: readonly string[]): ReadonlyMap<string, ChatThreadSummary>;
  deleteBySession(sessionId: string): void;
}
