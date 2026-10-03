import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatThreadDto } from './api';
import {
  readPersistedChatThreads,
  resolvePersistedSelectionAfterClose,
  writePersistedChatThread,
  writePersistedChatThreadState,
} from './chatThreadStorage';
import { restoreThreadView } from './components/chat/threadViewRestore';

function thread(sessionId: string): ChatThreadDto {
  return { sessionId, agentId: 'claude', title: sessionId, pinned: false, updatedAt: '2026-01-01T00:00:00Z' };
}

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

describe('writePersistedChatThreadState with an explicitly empty active set (bdboard-ij6e)', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the per-project entry (does not delete it) when the caller persists an empty active set', () => {
    // closeThread (chat/useChatThreadLists.ts) が最後の1つの開いているスレッドを
    // 閉じたとき、activeSessionIds: [] を明示的に永続化する。これは
    // 「このプロジェクトを訪れたことが無い」(= state === undefined)とは違う。
    writePersistedChatThreadState('project-a', { activeSessionIds: [], selectedSessionId: undefined });
    expect(readPersistedChatThreads()).toEqual({
      'project-a': { activeSessionIds: [], selectedSessionId: undefined },
    });
  });

  it(
    'reproduction (bdboard-ij6e): closing the last open thread must not make the next visit reopen every thread',
    () => {
      const threads = [thread('sess-1'), thread('sess-2')];
      // 1. 最後に開いていた1スレッドを閉じる (closeThread の next = [] のケース)。
      writePersistedChatThreadState('project-a', { activeSessionIds: [], selectedSessionId: undefined });
      // 2. 次回訪問 (E7 の初回一覧 fetch) は読み直した永続化状態を
      // restoreThreadView に渡す。意図的に全部閉じた直後なので、全スレッドが
      // 再び開いた状態で復元されてはいけない。
      const persisted = readPersistedChatThreads()['project-a'];
      expect(restoreThreadView(threads, persisted)).toEqual({ open: [], selected: undefined });
    },
  );
});

describe('writePersistedChatThread (bdboard-7feq)', () => {
  beforeEach(() => localStorage.clear());

  const threadD = { sessionId: 'sd', agentId: 'claude' };

  it('without liveOpen, appends to the persisted entry and moves the thread to the end (legacy sum)', () => {
    writePersistedChatThreadState('project-a', { activeSessionIds: ['s1', 'sd', 's2'], selectedSessionId: 's1' });
    writePersistedChatThread('project-a', threadD);
    expect(readPersistedChatThreads()['project-a']).toEqual({
      activeSessionIds: ['s1', 's2', 'sd'],
      selectedSessionId: 'sd',
    });
  });

  it('without liveOpen and no entry, persists just the thread', () => {
    writePersistedChatThread('project-a', threadD);
    expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['sd'], selectedSessionId: 'sd' });
  });

  it('with liveOpen, uses it as the base instead of the persisted entry, keeping its order', () => {
    writePersistedChatThreadState('project-a', { activeSessionIds: ['s9'], selectedSessionId: 's9' });
    writePersistedChatThread('project-a', { sessionId: 's2', agentId: 'claude' }, ['s1', 's2', 's3']);
    expect(readPersistedChatThreads()['project-a']).toEqual({
      activeSessionIds: ['s1', 's2', 's3'],
      selectedSessionId: 's2',
    });
  });

  it('with liveOpen that lacks the thread, appends it at the end', () => {
    writePersistedChatThread('project-a', threadD, ['s1', 's2']);
    expect(readPersistedChatThreads()['project-a']).toEqual({
      activeSessionIds: ['s1', 's2', 'sd'],
      selectedSessionId: 'sd',
    });
  });

  it('with an empty liveOpen, persists just the thread', () => {
    writePersistedChatThreadState('project-a', { activeSessionIds: ['s1'], selectedSessionId: 's1' });
    writePersistedChatThread('project-a', threadD, []);
    expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['sd'], selectedSessionId: 'sd' });
  });

  it('does not mutate the liveOpen array it is given', () => {
    const liveOpen = ['s1', 's2'];
    writePersistedChatThread('project-a', threadD, liveOpen);
    expect(liveOpen).toEqual(['s1', 's2']);
  });
});
