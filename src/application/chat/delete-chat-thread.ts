import type { ChatMessageRepository } from '../ports/chat-message-repository.js';
import type { ChatSessionRepository } from '../ports/chat-session-repository.js';

export function deleteChatThread(
  sessions: ChatSessionRepository,
  messages: ChatMessageRepository,
  projectId: string,
  sessionId: string,
): boolean {
  if (sessions.lookup(projectId, sessionId) === undefined) return false;
  messages.deleteBySession(sessionId);
  sessions.forget(projectId, sessionId);
  return true;
}
