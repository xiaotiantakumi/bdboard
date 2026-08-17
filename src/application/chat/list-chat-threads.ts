import type { ChatMessageRepository } from '../ports/chat-message-repository.js';
import type { ChatSessionRepository } from '../ports/chat-session-repository.js';

export interface ChatThread {
  readonly sessionId: string;
  readonly agentId: string;
  readonly title: string | null;
  readonly pinned: boolean;
  readonly updatedAt: Date;
}

function summarize(content: string): string {
  const chars = Array.from(content.trim());
  return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : chars.join('');
}

export function listChatThreads(
  sessions: ChatSessionRepository,
  messages: ChatMessageRepository,
  projectId: string,
): readonly ChatThread[] {
  const projectSessions = sessions.listByProject(projectId);
  const summaries = messages.listThreadSummaries(
    projectSessions.map((session) => session.sessionId),
  );
  return projectSessions
    .map((session) => {
      const summary = summaries.get(session.sessionId);
      const customTitle =
        session.title !== null && session.title.length > 0 ? session.title : undefined;
      return {
        sessionId: session.sessionId,
        agentId: session.agentId,
        title:
          customTitle ??
          (summary?.firstUserContentPrefix === undefined
            ? null
            : summarize(summary.firstUserContentPrefix)),
        pinned: session.pinned,
        updatedAt: summary?.lastMessageAt ?? session.lastUsedAt,
      };
    })
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
}
