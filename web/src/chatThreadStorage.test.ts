import { beforeEach, describe, expect, it } from 'vitest';
import {
  readPersistedChatThreads,
  resolvePersistedSelectionAfterClose,
  writePersistedChatThreadState,
} from './chatThreadStorage';

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

describe('resolvePersistedSelectionAfterClose (bdboard-e5cz)', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the persisted selection when it is still among the next active sessions', () => {
    writePersistedChatThreadState('project-a', {
      activeSessionIds: ['s1', 's2'],
      selectedSessionId: 's1',
    });
    expect(resolvePersistedSelectionAfterClose('project-a', ['s1'], 's-fallback')).toBe('s1');
  });

  it('falls back when the persisted selection is not among the next active sessions (e.g. it was just closed)', () => {
    writePersistedChatThreadState('project-a', {
      activeSessionIds: ['s1', 's2'],
      selectedSessionId: 's2',
    });
    expect(resolvePersistedSelectionAfterClose('project-a', ['s1'], 's-fallback')).toBe('s-fallback');
  });

  it('falls back when nothing is persisted for the project', () => {
    expect(resolvePersistedSelectionAfterClose('project-a', ['s1'], 's-fallback')).toBe('s-fallback');
  });
});
