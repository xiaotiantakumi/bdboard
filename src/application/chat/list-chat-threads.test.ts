import { describe, expect, it } from 'vitest';
import { CHAT_MESSAGE_MAX_LENGTH } from '../../domain/chat.js';
import type { ChatMessageRepository, ChatThreadSummary } from '../ports/chat-message-repository.js';
import type { ChatSessionRepository } from '../ports/chat-session-repository.js';
import { listChatThreads } from './list-chat-threads.js';

function fixtures(): { sessions: ChatSessionRepository; messages: ChatMessageRepository } {
  const sessions: ChatSessionRepository = {
    remember: () => {},
    updateModel: () => {},
    rename: () => {},
    setPinned: () => {},
    lookup: () => undefined,
    listByProject: () => [
      { sessionId: 'older', agentId: 'claude', lastUsedAt: new Date('2026-01-01T00:00:00Z'), title: null, pinned: false },
      { sessionId: 'newer', agentId: 'codex', lastUsedAt: new Date('2026-01-02T00:00:00Z'), title: null, pinned: false },
      { sessionId: 'empty', agentId: 'claude', lastUsedAt: new Date('2026-01-03T00:00:00Z'), title: null, pinned: false },
    ],
    forget: () => {},
  };
  const messagesBySession: Record<string, ReturnType<ChatMessageRepository['listBySession']>> = {
    older: [{ role: 'user', content: 'older question', createdAt: new Date('2026-01-04T00:00:00Z') }],
    newer: [
      { role: 'user', content: `${'x'.repeat(41)}tail`, createdAt: new Date('2026-01-05T00:00:00Z') },
      { role: 'assistant', content: 'answer', createdAt: new Date('2026-01-06T00:00:00Z') },
    ],
    empty: [],
  };
  const summaryFor = (sessionId: string): ChatThreadSummary | undefined => {
    const rows = messagesBySession[sessionId] ?? [];
    if (rows.length === 0) {
      return undefined;
    }
    const firstUser = rows.find((row) => row.role === 'user');
    return {
      firstUserContentPrefix:
        firstUser === undefined
          ? undefined
          : Array.from(firstUser.content).slice(0, CHAT_MESSAGE_MAX_LENGTH).join(''),
      lastMessageAt: rows.reduce(
        (latest, row) => (row.createdAt > latest ? row.createdAt : latest),
        rows[0].createdAt,
      ),
    };
  };
  const messages: ChatMessageRepository = {
    append: () => {},
    listBySession: (sessionId) => messagesBySession[sessionId] ?? [],
    listThreadSummaries: (sessionIds) =>
      new Map(
        sessionIds.flatMap((sessionId) => {
          const summary = summaryFor(sessionId);
          return summary === undefined ? [] : [[sessionId, summary] as const];
        }),
      ),
    deleteBySession: () => {},
  };
  return { sessions, messages };
}

describe('listChatThreads', () => {
  it('creates a truncated first-user title, null title, and sorts by updated time', () => {
    const { sessions, messages } = fixtures();
    expect(listChatThreads(sessions, messages, 'project-a')).toEqual([
      { sessionId: 'newer', agentId: 'codex', title: `${'x'.repeat(40)}…`, pinned: false, updatedAt: new Date('2026-01-06T00:00:00Z') },
      { sessionId: 'older', agentId: 'claude', title: 'older question', pinned: false, updatedAt: new Date('2026-01-04T00:00:00Z') },
      { sessionId: 'empty', agentId: 'claude', title: null, pinned: false, updatedAt: new Date('2026-01-03T00:00:00Z') },
    ]);
  });

  it('prefers a custom title over the auto-generated first-user title', () => {
    const { messages } = fixtures();
    const sessions: ChatSessionRepository = {
      remember: () => {},
      updateModel: () => {},
      rename: () => {},
      setPinned: () => {},
      lookup: () => undefined,
      listByProject: () => [
        {
          sessionId: 'newer',
          agentId: 'codex',
          lastUsedAt: new Date('2026-01-02T00:00:00Z'),
          title: 'bdboard運用相談',
          pinned: false,
        },
      ],
      forget: () => {},
    };

    expect(listChatThreads(sessions, messages, 'project-a')).toEqual([
      {
        sessionId: 'newer',
        agentId: 'codex',
        title: 'bdboard運用相談',
        pinned: false,
        updatedAt: new Date('2026-01-06T00:00:00Z'),
      },
    ]);
  });

  it('lists pinned threads before non-pinned threads regardless of updatedAt', () => {
    const { messages } = fixtures();
    const sessions: ChatSessionRepository = {
      remember: () => {},
      updateModel: () => {},
      rename: () => {},
      setPinned: () => {},
      lookup: () => undefined,
      listByProject: () => [
        { sessionId: 'newer', agentId: 'codex', lastUsedAt: new Date('2026-01-02T00:00:00Z'), title: null, pinned: false },
        { sessionId: 'older', agentId: 'claude', lastUsedAt: new Date('2026-01-01T00:00:00Z'), title: null, pinned: true },
      ],
      forget: () => {},
    };

    expect(listChatThreads(sessions, messages, 'project-a').map((thread) => thread.sessionId)).toEqual([
      'older',
      'newer',
    ]);
  });
});
