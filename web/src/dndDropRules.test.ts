import { describe, expect, it } from 'vitest';
import { LANES, type Lane } from './api';
import { isDropAllowed, resolveDropAction } from './dndDropRules';

describe('resolveDropAction', () => {
  it('maps ready → in_progress to claim', () => {
    expect(resolveDropAction('ready', 'in_progress')).toEqual({ kind: 'claim' });
  });

  it('maps any non-done source → done to close', () => {
    const sources: Lane[] = ['ready', 'in_progress', 'blocked'];
    for (const source of sources) {
      expect(resolveDropAction(source, 'done')).toEqual({ kind: 'close' });
    }
  });

  it('rejects drops onto blocked from every source lane (bdboard-662: merged blocked+deferred display lane, no unambiguous quick-action)', () => {
    for (const source of LANES) {
      expect(resolveDropAction(source, 'blocked')).toEqual({ kind: 'reject' });
    }
  });

  it('rejects same-lane drops', () => {
    for (const lane of LANES) {
      expect(resolveDropAction(lane, lane)).toEqual({ kind: 'reject' });
    }
  });

  it('rejects drops from done', () => {
    for (const target of LANES) {
      if (target === 'done') {
        continue;
      }
      expect(resolveDropAction('done', target)).toEqual({ kind: 'reject' });
    }
  });

  it('rejects transitions without a quick-action mapping', () => {
    expect(resolveDropAction('in_progress', 'ready')).toEqual({ kind: 'reject' });
    expect(resolveDropAction('blocked', 'in_progress')).toEqual({ kind: 'reject' });
    expect(resolveDropAction('blocked', 'ready')).toEqual({ kind: 'reject' });
  });

  it('rejects drops onto awaiting_human from every source lane (derived lane, no add-label quick-action)', () => {
    for (const source of LANES) {
      expect(resolveDropAction(source, 'awaiting_human')).toEqual({ kind: 'reject' });
    }
  });

  it('treats awaiting_human as a source like any other non-done lane', () => {
    expect(resolveDropAction('awaiting_human', 'done')).toEqual({ kind: 'close' });
    expect(resolveDropAction('awaiting_human', 'in_progress')).toEqual({ kind: 'reject' });
    expect(resolveDropAction('awaiting_human', 'ready')).toEqual({ kind: 'reject' });
  });
});

describe('isDropAllowed', () => {
  it('returns true only for non-reject actions', () => {
    expect(isDropAllowed('ready', 'in_progress')).toBe(true);
    expect(isDropAllowed('ready', 'done')).toBe(true);
    expect(isDropAllowed('ready', 'blocked')).toBe(false);
    expect(isDropAllowed('ready', 'ready')).toBe(false);
    expect(isDropAllowed('done', 'ready')).toBe(false);
  });
});
