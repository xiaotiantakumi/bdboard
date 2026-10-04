import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatThreadDto } from './api';
import {
  clearPersistedProvisionalMark,
  readPersistedChatThreads,
  resolvePersistedSelectionAfterClose,
  writePersistedChatThread,
  writePersistedChatThreadState,
  writePersistedProvisionalClosed,
  writePersistedProvisionalMark,
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

describe('provisional entry fields (bdboard-521p)', () => {
  const KEY = 'bdboard.chat.thread.v2';
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  describe('the validator', () => {
    it('reads an old-format entry (no provisional fields) unchanged: it is the user record', () => {
      // bdboard-521p 以前に書かれた形のリテラル。フィールドが増えても同じ値で読めること。
      localStorage.setItem(
        KEY,
        '{"project-a":{"activeSessionIds":["s1","s2"],"selectedSessionId":"s2"},"project-b":{"activeSessionIds":[]}}',
      );
      const read = readPersistedChatThreads();
      expect(read).toEqual({
        'project-a': { activeSessionIds: ['s1', 's2'], selectedSessionId: 's2' },
        'project-b': { activeSessionIds: [] },
      });
      expect(read['project-a']).not.toHaveProperty('provisional');
      expect(read['project-a']).not.toHaveProperty('provisionalClosedSessionIds');
    });

    it('accepts provisional: true and the closed ids, and keeps them on read', () => {
      localStorage.setItem(
        KEY,
        '{"project-a":{"activeSessionIds":["s1"],"selectedSessionId":"s1","provisional":true,"provisionalClosedSessionIds":["s0"]}}',
      );
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['s1'],
        selectedSessionId: 's1',
        provisional: true,
        provisionalClosedSessionIds: ['s0'],
      });
    });

    it.each([
      ['provisional: false', '{"activeSessionIds":["s1"],"provisional":false}'],
      ['provisional: a string', '{"activeSessionIds":["s1"],"provisional":"yes"}'],
      ['closed ids that are not an array', '{"activeSessionIds":["s1"],"provisional":true,"provisionalClosedSessionIds":"s0"}'],
      ['a non-string closed id', '{"activeSessionIds":["s1"],"provisional":true,"provisionalClosedSessionIds":[1]}'],
      ['an empty closed id', '{"activeSessionIds":["s1"],"provisional":true,"provisionalClosedSessionIds":[""]}'],
    ])('drops an entry with %s, like any other malformed entry', (_name, entry) => {
      localStorage.setItem(KEY, `{"project-a":${entry},"project-b":{"activeSessionIds":["ok"]}}`);
      expect(readPersistedChatThreads()).toEqual({ 'project-b': { activeSessionIds: ['ok'] } });
    });
  });

  describe('writePersistedProvisionalMark', () => {
    it('creates an empty provisional entry when the project has none', () => {
      writePersistedProvisionalMark('project-a');
      expect(readPersistedChatThreads()).toEqual({ 'project-a': { activeSessionIds: [], provisional: true } });
    });

    it('leaves an existing entry alone: it is the user record or already provisional', () => {
      writePersistedChatThreadState('project-a', { activeSessionIds: ['s1'], selectedSessionId: 's1' });
      writePersistedProvisionalMark('project-a');
      expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['s1'], selectedSessionId: 's1' });
    });
  });

  describe("carry-over: the writers do not pass the fields, and the existing entry's mark survives their write", () => {
    beforeEach(() => {
      writePersistedChatThreadState('project-a', {
        activeSessionIds: ['s1'], selectedSessionId: 's1', provisional: true, provisionalClosedSessionIds: ['s0'],
      });
    });
    const MARKED = { provisional: true, provisionalClosedSessionIds: ['s0'] };

    it('writePersistedChatThreadState keeps the mark and the closed ids', () => {
      writePersistedChatThreadState('project-a', { activeSessionIds: ['s1', 's2'], selectedSessionId: 's2' });
      expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['s1', 's2'], selectedSessionId: 's2', ...MARKED });
    });

    it('keeps the mark when the write empties the open set', () => {
      writePersistedChatThreadState('project-a', { activeSessionIds: [], selectedSessionId: undefined });
      expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: [], ...MARKED });
    });

    it('writePersistedChatThread keeps the mark, with and without liveOpen', () => {
      writePersistedChatThread('project-a', { sessionId: 's2', agentId: 'claude' });
      expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['s1', 's2'], selectedSessionId: 's2', ...MARKED });
      writePersistedChatThread('project-a', { sessionId: 's3', agentId: 'claude' }, ['s1', 's2']);
      expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['s1', 's2', 's3'], selectedSessionId: 's3', ...MARKED });
    });

    it('does not put a mark on a plain entry', () => {
      writePersistedChatThreadState('project-b', { activeSessionIds: ['s1'] });
      writePersistedChatThreadState('project-b', { activeSessionIds: ['s1', 's2'] });
      expect(readPersistedChatThreads()['project-b']).toEqual({ activeSessionIds: ['s1', 's2'] });
    });

    it('clearing the project (undefined) removes the mark with the entry', () => {
      writePersistedChatThreadState('project-a', undefined);
      expect(readPersistedChatThreads()['project-a']).toBeUndefined();
    });
  });

  describe('writePersistedProvisionalClosed', () => {
    it('writes the closed ids onto a provisional entry and drops the key when the set is empty', () => {
      writePersistedChatThreadState('project-a', { activeSessionIds: ['s1'], selectedSessionId: 's1', provisional: true });
      writePersistedProvisionalClosed('project-a', ['s0', 's9']);
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['s1'], selectedSessionId: 's1', provisional: true, provisionalClosedSessionIds: ['s0', 's9'],
      });
      writePersistedProvisionalClosed('project-a', []);
      expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['s1'], selectedSessionId: 's1', provisional: true });
      expect(readPersistedChatThreads()['project-a']).not.toHaveProperty('provisionalClosedSessionIds');
    });

    it('writes nothing for an entry that is not provisional, or for a project with no entry', () => {
      writePersistedChatThreadState('project-a', { activeSessionIds: ['s1'] });
      writePersistedProvisionalClosed('project-a', ['s0']);
      writePersistedProvisionalClosed('project-b', ['s0']);
      expect(readPersistedChatThreads()).toEqual({ 'project-a': { activeSessionIds: ['s1'] } });
    });
  });

  describe('clearPersistedProvisionalMark', () => {
    it('removes the mark and the closed ids and keeps the open set and the selection', () => {
      writePersistedChatThreadState('project-a', {
        activeSessionIds: ['s1', 's2'], selectedSessionId: 's2', provisional: true, provisionalClosedSessionIds: ['s0'],
      });
      clearPersistedProvisionalMark('project-a');
      const entry = readPersistedChatThreads()['project-a'];
      expect(entry).toEqual({ activeSessionIds: ['s1', 's2'], selectedSessionId: 's2' });
      expect(entry).not.toHaveProperty('provisional');
      expect(entry).not.toHaveProperty('provisionalClosedSessionIds');
      expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')).toEqual({
        'project-a': { activeSessionIds: ['s1', 's2'], selectedSessionId: 's2' },
      });
    });

    it('keeps an empty entry as an entry (it is the explicit empty, not a first visit)', () => {
      writePersistedChatThreadState('project-a', { activeSessionIds: [], provisional: true });
      clearPersistedProvisionalMark('project-a');
      expect(readPersistedChatThreads()).toEqual({ 'project-a': { activeSessionIds: [] } });
    });

    it('does not write when there is nothing to clear', () => {
      writePersistedChatThreadState('project-a', { activeSessionIds: ['s1'] });
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      clearPersistedProvisionalMark('project-a');
      clearPersistedProvisionalMark('project-none');
      expect(setItem).not.toHaveBeenCalled();
    });
  });

  it('does not throw when the storage is unavailable (it stays wrapped like the other writers)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writePersistedProvisionalMark('project-a')).not.toThrow();
    expect(() => writePersistedProvisionalClosed('project-a', ['s0'])).not.toThrow();
    expect(() => clearPersistedProvisionalMark('project-a')).not.toThrow();
  });
});
