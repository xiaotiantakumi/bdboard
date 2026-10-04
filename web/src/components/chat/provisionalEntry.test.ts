import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { readPersistedChatThreads, writePersistedChatThread, writePersistedChatThreadState } from '../../chatThreadStorage';
import { createProvisionalEntryMarks, isProvisionalEntry, withoutClosed } from './provisionalEntry';

function thread(sessionId: string): ChatThreadDto {
  return { sessionId, agentId: 'claude', title: null, pinned: false, updatedAt: '2026-01-01T00:00:00.000Z' };
}

const OPEN = { activeSessionIds: ['sess-1'] };

describe('isProvisionalEntry', () => {
  it('is true when the mark is set and an entry exists', () => {
    expect(isProvisionalEntry(true, OPEN)).toBe(true);
  });

  it('is false for a revisit record: no mark', () => {
    expect(isProvisionalEntry(false, OPEN)).toBe(false);
  });

  it('is false while no entry has appeared', () => {
    expect(isProvisionalEntry(true, undefined)).toBe(false);
  });

  it('is true for an empty entry while the mark is set: closing the only provisional thread leaves a provisional [], not a record', () => {
    expect(isProvisionalEntry(true, { activeSessionIds: [] })).toBe(true);
  });

  it('is false for an empty entry once the mark is down: the explicit empty an agent change writes is settled', () => {
    expect(isProvisionalEntry(false, { activeSessionIds: [] })).toBe(false);
  });
});

describe('withoutClosed', () => {
  const LIST = [thread('A'), thread('B'), thread('C')];

  it('drops only the closed ids and keeps the order', () => {
    expect(withoutClosed(LIST, new Set(['B'])).map((t) => t.sessionId)).toEqual(['A', 'C']);
  });

  it('returns the list as is when nothing is closed', () => {
    expect(withoutClosed(LIST, new Set())).toBe(LIST);
  });
});

describe('createProvisionalEntryMarks', () => {
  const restored = new Set<string>();
  const marks = createProvisionalEntryMarks((id) => restored.has(id));

  beforeEach(() => {
    localStorage.clear();
    restored.clear();
    marks.settle('proj-a');
    marks.settle('proj-b');
  });

  describe('markIfFirstEntry', () => {
    it('marks an unrestored project that has no persisted entry', () => {
      marks.markIfFirstEntry('proj-a');
      expect(marks.isProvisional('proj-a', OPEN)).toBe(true);
      expect(marks.isProvisional('proj-b', OPEN)).toBe(false);
    });

    it('does not mark a project that already has a persisted entry: that entry is the user\'s record', () => {
      writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-x'], selectedSessionId: 'sess-x' });
      marks.markIfFirstEntry('proj-a');
      expect(marks.isProvisional('proj-a', OPEN)).toBe(false);
    });

    it('does not mark a restored project, including the explicit empty entry an agent change leaves', () => {
      restored.add('proj-a');
      marks.markIfFirstEntry('proj-a');
      expect(marks.isProvisional('proj-a', OPEN)).toBe(false);
    });

    it('reads the restored state when it is called: an adoption must call it before marking the project restored', () => {
      marks.markIfFirstEntry('proj-a');
      restored.add('proj-a');
      expect(marks.isProvisional('proj-a', OPEN)).toBe(true);

      restored.clear();
      marks.settle('proj-a');
      restored.add('proj-a');
      marks.markIfFirstEntry('proj-a');
      expect(marks.isProvisional('proj-a', OPEN)).toBe(false);
    });

    it('keeps the mark when it is called again after the first entry was written (a second send is not a new first entry)', () => {
      marks.markIfFirstEntry('proj-a');
      writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
      marks.markIfFirstEntry('proj-a');
      expect(marks.isProvisional('proj-a', OPEN)).toBe(true);
    });
  });

  describe('noteClosed / closedIds', () => {
    it('remembers closed ids only while the project is marked', () => {
      marks.noteClosed('proj-a', 'sess-1');
      expect(marks.closedIds('proj-a').size).toBe(0);

      marks.markIfFirstEntry('proj-a');
      marks.noteClosed('proj-a', 'sess-1');
      marks.noteClosed('proj-a', 'sess-2');
      expect(Array.from(marks.closedIds('proj-a'))).toEqual(['sess-1', 'sess-2']);
      expect(marks.closedIds('proj-b').size).toBe(0);
    });
  });

  describe('noteReopened', () => {
    it('takes a reopened id off the closed ids, for that project only, and ignores an id that was never closed', () => {
      marks.markIfFirstEntry('proj-a');
      marks.markIfFirstEntry('proj-b');
      marks.noteClosed('proj-a', 'sess-1');
      marks.noteClosed('proj-a', 'sess-2');
      marks.noteClosed('proj-b', 'sess-1');

      marks.noteReopened('proj-a', 'sess-1');
      marks.noteReopened('proj-a', 'sess-never-closed');

      expect(Array.from(marks.closedIds('proj-a'))).toEqual(['sess-2']);
      expect(Array.from(marks.closedIds('proj-b'))).toEqual(['sess-1']);
    });

    it('does nothing for an unmarked project and does not raise the mark', () => {
      marks.noteReopened('proj-a', 'sess-1');
      expect(marks.closedIds('proj-a').size).toBe(0);
      expect(marks.isProvisional('proj-a', OPEN)).toBe(false);
    });

    it('lets the id be closed again afterwards', () => {
      marks.markIfFirstEntry('proj-a');
      marks.noteClosed('proj-a', 'sess-1');
      marks.noteReopened('proj-a', 'sess-1');
      marks.noteClosed('proj-a', 'sess-1');
      expect(marks.closedIds('proj-a').has('sess-1')).toBe(true);
    });
  });

  describe('settle', () => {
    it('lowers the mark and forgets the closed ids, for that project only', () => {
      marks.markIfFirstEntry('proj-a');
      marks.markIfFirstEntry('proj-b');
      marks.noteClosed('proj-a', 'sess-1');
      marks.noteClosed('proj-b', 'sess-1');
      const held = marks.closedIds('proj-a');

      marks.settle('proj-a');

      expect(marks.isProvisional('proj-a', OPEN)).toBe(false);
      expect(marks.closedIds('proj-a').size).toBe(0);
      expect(marks.isProvisional('proj-b', OPEN)).toBe(true);
      expect(marks.closedIds('proj-b').has('sess-1')).toBe(true);
      // 復元する側が先に読んだ閉じた id は、settle のあとでも読める(読んでから settle する順で使う)。
      expect(held.has('sess-1')).toBe(true);
    });
  });
});

// bdboard-521p: 印と閉じた id は保存エントリにも持つ。リロードやチャットパネルを閉じて開く(ChatPanel の再マウント)と
// createProvisionalEntryMarks が作り直されるので、「再マウント」はここでは新しいインスタンスを作り、保存だけを引き継ぐこと。
describe('createProvisionalEntryMarks: the mark and the closed ids survive a remount (bdboard-521p)', () => {
  const restored = new Set<string>();
  const mount = () => createProvisionalEntryMarks((id) => restored.has(id));

  beforeEach(() => {
    localStorage.clear();
    restored.clear();
  });

  /** 未復元の初回訪問で、仮のエントリ [sess-1] を書いた状態(送信成功と同じ順: 印 → 書き込み)。 */
  function writeProvisionalFirstEntry(marks: ReturnType<typeof mount>) {
    marks.markIfFirstEntry('proj-a');
    writePersistedChatThread('proj-a', { sessionId: 'sess-1', agentId: 'claude' });
  }

  it('markIfFirstEntry puts the mark on the stored entry, and the write that fills the entry keeps it', () => {
    const marks = mount();
    marks.markIfFirstEntry('proj-a');
    expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: [], provisional: true });
    writePersistedChatThread('proj-a', { sessionId: 'sess-1', agentId: 'claude' });
    expect(readPersistedChatThreads()['proj-a']).toEqual({
      activeSessionIds: ['sess-1'],
      selectedSessionId: 'sess-1',
      provisional: true,
    });
  });

  it('a fresh mount reads a provisional entry as provisional, from the storage alone', () => {
    writeProvisionalFirstEntry(mount());

    const remounted = mount();
    expect(remounted.isProvisional('proj-a', readPersistedChatThreads()['proj-a'])).toBe(true);
    expect(remounted.isProvisional('proj-b', readPersistedChatThreads()['proj-b'])).toBe(false);
  });

  it('a fresh mount does not mark again and keeps the entry provisional when a later write lands (the entry exists)', () => {
    writeProvisionalFirstEntry(mount());

    const remounted = mount();
    remounted.markIfFirstEntry('proj-a');
    writePersistedChatThread('proj-a', { sessionId: 'sess-2', agentId: 'claude' });
    expect(readPersistedChatThreads()['proj-a']).toEqual({
      activeSessionIds: ['sess-1', 'sess-2'],
      selectedSessionId: 'sess-2',
      provisional: true,
    });
    expect(mount().isProvisional('proj-a', readPersistedChatThreads()['proj-a'])).toBe(true);
  });

  it('the closed ids survive a remount, and a close after the remount adds to them', () => {
    const marks = mount();
    writeProvisionalFirstEntry(marks);
    marks.noteClosed('proj-a', 'sess-x');
    expect(readPersistedChatThreads()['proj-a']?.provisionalClosedSessionIds).toEqual(['sess-x']);

    const remounted = mount();
    expect(Array.from(remounted.closedIds('proj-a'))).toEqual(['sess-x']);
    remounted.noteClosed('proj-a', 'sess-y');
    expect(readPersistedChatThreads()['proj-a']?.provisionalClosedSessionIds).toEqual(['sess-x', 'sess-y']);
    expect(Array.from(mount().closedIds('proj-a'))).toEqual(['sess-x', 'sess-y']);
  });

  it('a close that is the first call of a fresh mount still counts: the project is marked by the stored entry', () => {
    writeProvisionalFirstEntry(mount());

    const remounted = mount();
    remounted.noteClosed('proj-a', 'sess-x');
    expect(Array.from(remounted.closedIds('proj-a'))).toEqual(['sess-x']);
    expect(readPersistedChatThreads()['proj-a']?.provisionalClosedSessionIds).toEqual(['sess-x']);
  });

  it('noteReopened is stored: a thread closed and reopened is not a closed id on the next mount', () => {
    const marks = mount();
    writeProvisionalFirstEntry(marks);
    marks.noteClosed('proj-a', 'sess-x');
    marks.noteClosed('proj-a', 'sess-y');
    marks.noteReopened('proj-a', 'sess-x');
    expect(readPersistedChatThreads()['proj-a']?.provisionalClosedSessionIds).toEqual(['sess-y']);

    expect(Array.from(mount().closedIds('proj-a'))).toEqual(['sess-y']);
    marks.noteReopened('proj-a', 'sess-y');
    expect(readPersistedChatThreads()['proj-a']).not.toHaveProperty('provisionalClosedSessionIds');
    expect(mount().closedIds('proj-a').size).toBe(0);
  });

  it('settle takes the mark and the closed ids off the stored entry and keeps its open set: the next mount reads a record', () => {
    const marks = mount();
    writeProvisionalFirstEntry(marks);
    marks.noteClosed('proj-a', 'sess-x');

    marks.settle('proj-a');

    expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
    const remounted = mount();
    expect(remounted.isProvisional('proj-a', readPersistedChatThreads()['proj-a'])).toBe(false);
    expect(remounted.closedIds('proj-a').size).toBe(0);
  });

  it('settle on a fresh mount lowers a mark left by an earlier visit, so a write after it is not provisional', () => {
    writeProvisionalFirstEntry(mount());

    const remounted = mount();
    remounted.settle('proj-a');
    writePersistedChatThreadState('proj-a', { activeSessionIds: [], selectedSessionId: undefined });
    expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: [] });
    expect(mount().isProvisional('proj-a', readPersistedChatThreads()['proj-a'])).toBe(false);
  });

  it('an old-format stored entry (no provisional fields) is the user record on a fresh mount', () => {
    // bdboard-521p 以前に書かれた形のリテラル。
    localStorage.setItem(
      'bdboard.chat.thread.v2',
      '{"proj-a":{"activeSessionIds":["sess-1","sess-2"],"selectedSessionId":"sess-1"}}',
    );
    const marks = mount();
    expect(marks.isProvisional('proj-a', readPersistedChatThreads()['proj-a'])).toBe(false);
    expect(marks.closedIds('proj-a').size).toBe(0);
    marks.markIfFirstEntry('proj-a');
    marks.noteClosed('proj-a', 'sess-2');
    expect(marks.closedIds('proj-a').size).toBe(0);
    expect(readPersistedChatThreads()['proj-a']).toEqual({
      activeSessionIds: ['sess-1', 'sess-2'],
      selectedSessionId: 'sess-1',
    });
  });

  it('a restored project that has no stored entry is not marked and leaves nothing in the storage', () => {
    restored.add('proj-a');
    mount().markIfFirstEntry('proj-a');
    expect(readPersistedChatThreads()['proj-a']).toBeUndefined();
  });
});

describe('createProvisionalEntryMarks: noteListUnavailable, a list fetch that failed is not a restore (bdboard-521p)', () => {
  const restored = new Set<string>();
  const mount = () => createProvisionalEntryMarks((id) => restored.has(id));

  beforeEach(() => {
    localStorage.clear();
    restored.clear();
  });

  it('marks the first entry of a project that a failed list left restored', () => {
    const marks = mount();
    restored.add('proj-a');
    marks.noteListUnavailable('proj-a');

    marks.markIfFirstEntry('proj-a');
    writePersistedChatThread('proj-a', { sessionId: 'sess-1', agentId: 'claude' }, []);

    const entry = readPersistedChatThreads()['proj-a'];
    expect(entry).toEqual({ activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1', provisional: true });
    expect(marks.isProvisional('proj-a', entry)).toBe(true);
    expect(mount().isProvisional('proj-a', entry)).toBe(true);
  });

  it('does not mark a restored project whose list did not fail', () => {
    const marks = mount();
    restored.add('proj-a');
    marks.markIfFirstEntry('proj-a');
    expect(readPersistedChatThreads()['proj-a']).toBeUndefined();
  });

  it('does not mark when an entry exists: after a failed list that entry is still the user record', () => {
    writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
    const marks = mount();
    restored.add('proj-a');
    marks.noteListUnavailable('proj-a');
    marks.markIfFirstEntry('proj-a');
    expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
    expect(marks.isProvisional('proj-a', readPersistedChatThreads()['proj-a'])).toBe(false);
  });

  it('isListUnavailable reads the same note: set by noteListUnavailable, lowered by settle, per project, memory only', () => {
    const marks = mount();
    expect(marks.isListUnavailable('proj-a')).toBe(false);
    marks.noteListUnavailable('proj-a');
    expect(marks.isListUnavailable('proj-a')).toBe(true);
    expect(marks.isListUnavailable('proj-b')).toBe(false);
    // 別マウント(リロード・パネルを閉じる)では消える: E7 が最初からやり直す。
    expect(mount().isListUnavailable('proj-a')).toBe(false);
    marks.settle('proj-a');
    expect(marks.isListUnavailable('proj-a')).toBe(false);
  });

  it('is lowered by settle: after an agent change or a restore from the list, a first entry is not provisional', () => {
    const marks = mount();
    restored.add('proj-a');
    marks.noteListUnavailable('proj-a');
    marks.settle('proj-a');
    marks.markIfFirstEntry('proj-a');
    expect(readPersistedChatThreads()['proj-a']).toBeUndefined();
  });

  it('is for that project only', () => {
    const marks = mount();
    restored.add('proj-a');
    restored.add('proj-b');
    marks.noteListUnavailable('proj-a');
    marks.markIfFirstEntry('proj-b');
    expect(readPersistedChatThreads()['proj-b']).toBeUndefined();
  });
});
