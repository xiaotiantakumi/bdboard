import { describe, expect, it } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { keepOpenThreadEntries } from './keepOpenThreadEntries';

function thread(sessionId: string, title = sessionId): ChatThreadDto {
  return { sessionId, agentId: 'claude', title, pinned: false, updatedAt: '2026-01-01T00:00:00Z' };
}

describe('keepOpenThreadEntries (bdboard-znnl)', () => {
  it('returns a copy of the fetched list when there is no current list', () => {
    const fetched = [thread('a'), thread('b')];
    const result = keepOpenThreadEntries(fetched, undefined, ['a']);
    expect(result).toEqual(fetched);
    expect(result).not.toBe(fetched);
  });

  it('returns the fetched list when no tab is open', () => {
    expect(keepOpenThreadEntries([thread('a')], [thread('a'), thread('x')], undefined)).toEqual([thread('a')]);
    expect(keepOpenThreadEntries([thread('a')], [thread('a'), thread('x')], [])).toEqual([thread('a')]);
  });

  it('appends current entries that are open but missing from the fetched list', () => {
    const result = keepOpenThreadEntries(
      [thread('a'), thread('b')],
      [thread('a'), thread('adopted', 'resumed title')],
      ['a', 'adopted'],
    );
    expect(result).toEqual([thread('a'), thread('b'), thread('adopted', 'resumed title')]);
  });

  it('drops current entries that are not open and missing from the fetched list', () => {
    expect(keepOpenThreadEntries([thread('a')], [thread('a'), thread('closed')], ['a'])).toEqual([thread('a')]);
  });

  it('prefers the fetched entry when both lists have the same id', () => {
    const result = keepOpenThreadEntries([thread('a', 'fresh')], [thread('a', 'old')], ['a']);
    expect(result).toEqual([thread('a', 'fresh')]);
  });

  it('does not add an open id the current list does not have either', () => {
    expect(keepOpenThreadEntries([thread('a')], [thread('a')], ['a', 'ghost'])).toEqual([thread('a')]);
  });
});
