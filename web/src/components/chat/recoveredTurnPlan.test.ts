import { describe, expect, it } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { planRecoveredTurn, type RecoveredTurnPlanInput } from './recoveredTurnPlan';

// applyRecoveredTurn(chat/useChatSessionLifecycle.ts)が open と選択を決める部分。
// bdboard-tsen / bdboard-4w2d / bdboard-cemi の既存の規則はフック越しの
// useChatSessionLifecycle.test.tsx が見るので、ここは純粋関数としての入出力と、
// bdboard-w9hv の置き換えを固定する。

function thread(sessionId: string): ChatThreadDto {
  return { sessionId, agentId: 'claude', title: null, pinned: false, updatedAt: '2026-01-01T00:00:00.000Z' };
}

function plan(overrides: Partial<RecoveredTurnPlanInput> = {}) {
  return planRecoveredTurn({
    threads: [],
    sessionId: 'C',
    origin: undefined,
    alreadyRestored: true,
    knownOpen: ['A', 'B'],
    persisted: undefined,
    provisionalEntry: false,
    knownSelected: 'A',
    explicitDraftSelected: false,
    ...overrides,
  });
}

describe('planRecoveredTurn', () => {
  it('appends the recovered session and keeps the live selection when there is no origin', () => {
    expect(plan()).toEqual({
      nextOpen: ['A', 'B', 'C'],
      nextSelected: 'A',
      persistedSelected: 'A',
      replacedKey: undefined,
    });
  });

  it('selects the recovered session when nothing is selected', () => {
    expect(plan({ knownSelected: undefined })).toMatchObject({ nextSelected: 'C', persistedSelected: 'C' });
  });

  it('restores from the persisted entry and the racing live open when the project is not restored yet', () => {
    const result = plan({
      alreadyRestored: false,
      knownOpen: ['racing'],
      threads: [thread('A'), thread('B'), thread('C')],
      persisted: { activeSessionIds: ['gone', 'B', 'A'], selectedSessionId: 'A' },
      knownSelected: undefined,
    });
    expect(result.nextOpen).toEqual(['B', 'A', 'racing', 'C']);
    expect(result.nextSelected).toBe('A');
  });

  describe('a provisional first entry (bdboard-rt6i)', () => {
    const SERVER = [thread('A'), thread('B'), thread('N'), thread('C')];

    it('opens the server list together with the provisional [N] and the recovered session, not just [N, C] (gap 1)', () => {
      // 初回訪問で、E7 の一覧 fetch が in-flight の間に送信成功が [N] を書いた(未復元)。
      const result = plan({
        alreadyRestored: false,
        provisionalEntry: true,
        knownOpen: ['N'],
        threads: SERVER,
        persisted: { activeSessionIds: ['N'], selectedSessionId: 'N' },
        knownSelected: 'N',
      });
      expect(result.nextOpen).toEqual(['A', 'B', 'N', 'C']);
      expect(result.nextSelected).toBe('N');
      expect(result.persistedSelected).toBe('N');
    });

    it('treats the same entry as a revisit record when it is not provisional', () => {
      const result = plan({
        alreadyRestored: false,
        provisionalEntry: false,
        knownOpen: ['N'],
        threads: SERVER,
        persisted: { activeSessionIds: ['N'], selectedSessionId: 'N' },
        knownSelected: 'N',
      });
      expect(result.nextOpen).toEqual(['N', 'C']);
    });

    it('adds the server list to an adopted open that is already restored, keeping an id the list does not carry yet', () => {
      const result = plan({
        alreadyRestored: true,
        provisionalEntry: true,
        knownOpen: ['adopted'],
        threads: SERVER,
        persisted: { activeSessionIds: ['adopted'], selectedSessionId: 'adopted' },
        knownSelected: 'adopted',
      });
      // 回収したセッション C は末尾に付く(planReplacedThread の規則)。
      expect(result.nextOpen).toEqual(['A', 'B', 'N', 'adopted', 'C']);
      expect(result.nextSelected).toBe('adopted');
    });

    it('keeps the persisted selection while a draft is shown, and still widens the open set', () => {
      const result = plan({
        alreadyRestored: false,
        provisionalEntry: true,
        explicitDraftSelected: true,
        knownOpen: ['N'],
        threads: SERVER,
        persisted: { activeSessionIds: ['N'], selectedSessionId: 'N' },
        knownSelected: undefined,
      });
      expect(result.nextOpen).toEqual(['A', 'B', 'N', 'C']);
      expect(result.nextSelected).toBeUndefined();
      expect(result.persistedSelected).toBe('N');
    });
  });

  describe('threads the user closed during the provisional entry (bdboard-rt6i)', () => {
    const SERVER = [thread('A'), thread('B'), thread('N1'), thread('N2'), thread('C')];

    it('leaves the closed ids out of the widened open set (N1 -> N2 -> close N1)', () => {
      const result = plan({
        alreadyRestored: false,
        provisionalEntry: true,
        closedIds: new Set(['N1']),
        knownOpen: ['N2'],
        threads: SERVER,
        persisted: { activeSessionIds: ['N2'], selectedSessionId: 'N2' },
        knownSelected: 'N2',
      });
      expect(result.nextOpen).toEqual(['A', 'B', 'N2', 'C']);
    });

    it('ignores closed ids when the entry is not provisional (they are only recorded while an entry is provisional)', () => {
      const result = plan({
        alreadyRestored: true,
        provisionalEntry: false,
        closedIds: new Set(['A']),
        knownOpen: ['A', 'B'],
        threads: SERVER,
        persisted: { activeSessionIds: ['A', 'B'], selectedSessionId: 'A' },
      });
      expect(result.nextOpen).toEqual(['A', 'B', 'C']);
    });
  });

  describe('a replaced thread (bdboard-w9hv)', () => {
    it('drops an open origin from the next open, as commitSuccess does', () => {
      expect(plan({ origin: 'B' })).toMatchObject({ nextOpen: ['A', 'C'], replacedKey: 'B', nextSelected: 'A' });
    });

    it('moves the live selection to the recovered session when it pointed at the origin', () => {
      expect(plan({ origin: 'B', knownSelected: 'B' })).toMatchObject({
        nextOpen: ['A', 'C'],
        nextSelected: 'C',
        persistedSelected: 'C',
      });
    });

    it('also drops an origin that the restoration brought in (the server still lists it)', () => {
      const result = plan({
        origin: 'B',
        alreadyRestored: false,
        knownOpen: undefined,
        threads: [thread('A'), thread('B'), thread('C')],
        persisted: { activeSessionIds: ['A', 'B'], selectedSessionId: 'B' },
        knownSelected: undefined,
      });
      expect(result).toMatchObject({ nextOpen: ['A', 'C'], replacedKey: 'B', nextSelected: 'C' });
    });

    it('does not replace an origin that is not open (a draft key, or already dropped)', () => {
      expect(plan({ origin: 'draft-1' })).toMatchObject({ nextOpen: ['A', 'B', 'C'], replacedKey: undefined });
    });

    it('does not replace when the recovered session is already open', () => {
      expect(plan({ origin: 'B', sessionId: 'A' })).toMatchObject({ nextOpen: ['B', 'A'], replacedKey: undefined });
    });
  });

  describe('while an explicit draft is shown (bdboard-cemi)', () => {
    it('keeps the live selection undefined and the persisted selection as it was', () => {
      expect(
        plan({
          explicitDraftSelected: true,
          knownSelected: undefined,
          persisted: { activeSessionIds: ['A', 'B'], selectedSessionId: 'A' },
        }),
      ).toMatchObject({ nextSelected: undefined, persistedSelected: 'A' });
    });

    it('keeps an undefined persisted selection undefined, even when a thread was replaced', () => {
      expect(plan({ explicitDraftSelected: true, knownSelected: undefined, origin: 'B' })).toMatchObject({
        nextSelected: undefined,
        persistedSelected: undefined,
        replacedKey: 'B',
      });
    });

    it('moves a persisted selection that pointed at the replaced thread to the recovered session', () => {
      expect(
        plan({
          explicitDraftSelected: true,
          knownSelected: undefined,
          origin: 'B',
          persisted: { activeSessionIds: ['A', 'B'], selectedSessionId: 'B' },
        }),
      ).toMatchObject({ nextSelected: undefined, persistedSelected: 'C', replacedKey: 'B' });
    });
  });
});
