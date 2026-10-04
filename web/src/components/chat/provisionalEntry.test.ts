import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { writePersistedChatThreadState } from '../../chatThreadStorage';
import { createProvisionalEntryMarks, isProvisionalEntry, withoutClosed } from './provisionalEntry';

function thread(sessionId: string): ChatThreadDto {
  return { sessionId, agentId: 'claude', title: null, pinned: false, updatedAt: '2026-01-01T00:00:00.000Z' };
}

const OPEN = { activeSessionIds: ['sess-1'] };

describe('isProvisionalEntry', () => {
  it('is true only when the mark is set and an entry with open threads exists', () => {
    expect(isProvisionalEntry(true, OPEN)).toBe(true);
  });

  it('is false for a revisit record: no mark', () => {
    expect(isProvisionalEntry(false, OPEN)).toBe(false);
  });

  it('is false while no entry has appeared', () => {
    expect(isProvisionalEntry(true, undefined)).toBe(false);
  });

  it('is false for an entry with no open threads, which is the explicit empty an agent change writes', () => {
    expect(isProvisionalEntry(true, { activeSessionIds: [] })).toBe(false);
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
