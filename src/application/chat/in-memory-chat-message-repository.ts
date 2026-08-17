import { CHAT_MESSAGES_MAX_PER_SESSION, CHAT_MESSAGE_MAX_LENGTH } from '../../domain/chat.js';
import type {
  ChatMessageAppendInput,
  ChatMessageRecord,
  ChatMessageRepository,
  ChatThreadSummary,
} from '../ports/chat-message-repository.js';

export function createInMemoryChatMessageRepository(options?: {
  readonly maxMessagesPerSession?: number;
}): ChatMessageRepository {
  const maxMessagesPerSession =
    options?.maxMessagesPerSession ?? CHAT_MESSAGES_MAX_PER_SESSION;
  const bySession = new Map<string, ChatMessageRecord[]>();

  const trimToCap = (sessionId: string): void => {
    const messages = bySession.get(sessionId);
    if (messages === undefined || messages.length <= maxMessagesPerSession) {
      return;
    }
    bySession.set(
      sessionId,
      messages.slice(messages.length - maxMessagesPerSession),
    );
  };

  return {
    append(sessionId: string, messages: readonly ChatMessageAppendInput[]): void {
      if (messages.length === 0) {
        return;
      }

      const existing = bySession.get(sessionId) ?? [];
      const appended = messages.map(
        (message): ChatMessageRecord => ({
          role: message.role,
          content: message.content,
          createdAt: message.createdAt ?? new Date(),
          ...(message.failedTools !== undefined && message.failedTools.length > 0
            ? { failedTools: message.failedTools }
            : {}),
          ...(message.agentWarnings !== undefined && message.agentWarnings.length > 0
            ? { agentWarnings: message.agentWarnings }
            : {}),
        }),
      );
      bySession.set(sessionId, [...existing, ...appended]);
      trimToCap(sessionId);
    },

    listBySession(sessionId: string): readonly ChatMessageRecord[] {
      return bySession.get(sessionId) ?? [];
    },

    listThreadSummaries(sessionIds: readonly string[]): ReadonlyMap<string, ChatThreadSummary> {
      const summaries = new Map<string, ChatThreadSummary>();
      for (const sessionId of sessionIds) {
        const messages = bySession.get(sessionId);
        if (messages === undefined || messages.length === 0) {
          continue;
        }

        const orderedMessages = messages
          .map((message, index) => ({ message, index }))
          .sort(
            (a, b) =>
              a.message.createdAt.getTime() - b.message.createdAt.getTime() ||
              a.index - b.index,
          )
          .map(({ message }) => message);
        const firstUser = orderedMessages.find((message) => message.role === 'user');
        const lastMessageAt = messages.reduce(
          (latest, message) =>
            message.createdAt > latest ? message.createdAt : latest,
          messages[0].createdAt,
        );
        summaries.set(sessionId, {
          firstUserContentPrefix:
            firstUser === undefined
              ? undefined
              : Array.from(firstUser.content).slice(0, CHAT_MESSAGE_MAX_LENGTH).join(''),
          lastMessageAt,
        });
      }
      return summaries;
    },

    deleteBySession(sessionId: string): void {
      bySession.delete(sessionId);
    },
  };
}
