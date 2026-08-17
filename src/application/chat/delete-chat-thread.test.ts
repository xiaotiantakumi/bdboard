import { describe, expect, it } from 'vitest';
import { createInMemoryChatMessageRepository } from './in-memory-chat-message-repository.js';
import { createInMemoryChatSessionRepository } from './chat-session-store.js';
import { deleteChatThread } from './delete-chat-thread.js';

describe('deleteChatThread', () => {
  it('deletes messages and the session record', () => {
    const sessions = createInMemoryChatSessionRepository();
    const messages = createInMemoryChatMessageRepository();
    sessions.remember('project-a', 'session-a', 'claude');
    messages.append('session-a', [{ role: 'user', content: 'remove' }]);

    expect(deleteChatThread(sessions, messages, 'project-a', 'session-a')).toBe(true);
    expect(sessions.lookup('project-a', 'session-a')).toBeUndefined();
    expect(messages.listBySession('session-a')).toEqual([]);
  });

  it('rejects unknown and cross-project sessions without deleting messages', () => {
    const sessions = createInMemoryChatSessionRepository();
    const messages = createInMemoryChatMessageRepository();
    sessions.remember('project-b', 'session-b', 'claude');
    messages.append('session-b', [{ role: 'user', content: 'keep' }]);

    expect(deleteChatThread(sessions, messages, 'project-a', 'session-b')).toBe(false);
    expect(deleteChatThread(sessions, messages, 'project-a', 'missing')).toBe(false);
    expect(messages.listBySession('session-b')).toHaveLength(1);
  });
});
