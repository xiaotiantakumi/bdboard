import { beforeEach, describe, expect, it } from 'vitest';
import { readPersistedChatThreads, writePersistedChatThreadState } from './chatThreadStorage';

describe('chatThreadStorage v2', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips ordered active sessions and selection', () => {
    writePersistedChatThreadState('project-a', {
      activeSessionIds: ['s1', 's2'],
      selectedSessionId: 's2',
    });
    expect(readPersistedChatThreads()).toEqual({
      'project-a': { activeSessionIds: ['s1', 's2'], selectedSessionId: 's2' },
    });
  });

  it('treats old v1 and malformed data as empty', () => {
    localStorage.setItem('bdboard.chat.thread.v1', JSON.stringify({ 'project-a': { sessionId: 's1', agentId: 'claude' } }));
    expect(readPersistedChatThreads()).toEqual({});
    localStorage.setItem('bdboard.chat.thread.v2', '{broken');
    expect(readPersistedChatThreads()).toEqual({});
  });
});
