import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import type { Lane } from '../../api';
import type { BulkSelectionContextValue } from '../BulkSelectionProvider';
import {
  handleEscapeKey,
  handleNormalMovementKey,
  handleRangeSelectionKey,
  handleToggleSelectionKey,
} from './containerKeyHandlers';

function event(key: string, shiftKey = false) {
  const value = { key, shiftKey, preventDefault: vi.fn() };
  return { value, typed: value as unknown as ReactKeyboardEvent<HTMLElement> };
}

function selection(selectedIds: ReadonlySet<string> = new Set(['selected'])): BulkSelectionContextValue {
  return {
    selectedIds, isSelected: vi.fn(), toggle: vi.fn(), selectRange: vi.fn(),
    deselectAll: vi.fn(), clear: vi.fn(),
  };
}

function refs() {
  const rangeAnchorRef = createRef<string | null>();
  rangeAnchorRef.current = null;
  const lastRangeIdsRef = createRef<readonly string[]>() as RefObject<readonly string[]>;
  lastRangeIdsRef.current = [];
  return { rangeAnchorRef, lastRangeIdsRef };
}

describe('handleEscapeKey', () => {
  it('clears non-empty selection and reports handled', () => {
    const ev = event('Escape');
    const bulkSelection = selection();
    const resetRangeSelectionRefs = vi.fn();
    expect(handleEscapeKey(ev.typed, { bulkSelection, resetRangeSelectionRefs })).toBe(true);
    expect(ev.value.preventDefault).toHaveBeenCalledOnce();
    expect(bulkSelection.clear).toHaveBeenCalledOnce();
    expect(resetRangeSelectionRefs).toHaveBeenCalledOnce();
  });

  it.each([null, selection(new Set())])('leaves empty or null selection unhandled', (bulkSelection) => {
    const ev = event('Escape');
    const resetRangeSelectionRefs = vi.fn();
    expect(handleEscapeKey(ev.typed, { bulkSelection, resetRangeSelectionRefs })).toBe(false);
    expect(ev.value.preventDefault).not.toHaveBeenCalled();
    expect(resetRangeSelectionRefs).not.toHaveBeenCalled();
  });
});

describe('handleToggleSelectionKey', () => {
  it('toggles a focused card and resets range refs', () => {
    const ev = event('x');
    const bulkSelection = selection();
    const { rangeAnchorRef, lastRangeIdsRef } = refs();
    lastRangeIdsRef.current = ['a'];
    handleToggleSelectionKey(ev.typed, { bulkSelection, focusedCardId: 'b', rangeAnchorRef, lastRangeIdsRef });
    expect(ev.value.preventDefault).toHaveBeenCalledOnce();
    expect(bulkSelection.toggle).toHaveBeenCalledWith('b');
    expect(rangeAnchorRef.current).toBe('b');
    expect(lastRangeIdsRef.current).toEqual([]);
  });

  it.each([[null, selection()], ['a', null]] as const)('does nothing without focus or selection', (focusedCardId, bulkSelection) => {
    const ev = event('X');
    const range = refs();
    handleToggleSelectionKey(ev.typed, { bulkSelection, focusedCardId, ...range });
    expect(ev.value.preventDefault).not.toHaveBeenCalled();
    if (bulkSelection !== null) expect(bulkSelection.toggle).not.toHaveBeenCalled();
  });
});

describe('handleRangeSelectionKey', () => {
  function rangeParams(overrides: Partial<Parameters<typeof handleRangeSelectionKey>[1]> = {}) {
    const range = refs();
    const bulkSelection = selection();
    const params = {
      direction: 'next' as const, bulkSelection, focusedCardId: 'b',
      getDefaultFocusedCardId: vi.fn(() => 'a'),
      findLaneForCard: vi.fn(() => 'lane' as unknown as Lane),
      laneCardsRef: { current: new Map([['lane' as unknown as Lane, ['a', 'b', 'c']]]) },
      resolveMoveWithinLane: vi.fn(() => 'c'), focusCardByKeyboard: vi.fn(),
      ...range, ...overrides,
    };
    return { params, bulkSelection };
  }

  it.each(['next', 'prev'] as const)('focuses and selects the %s range', (direction) => {
    const ev = event('ArrowDown', true);
    const { params, bulkSelection } = rangeParams({ direction });
    handleRangeSelectionKey(ev.typed, params);
    expect(ev.value.preventDefault).toHaveBeenCalledOnce();
    expect(params.resolveMoveWithinLane).toHaveBeenCalledWith('b', direction);
    expect(params.focusCardByKeyboard).toHaveBeenCalledWith('c');
    expect(bulkSelection.selectRange).toHaveBeenCalledWith(['a', 'b', 'c'], 'b', 'c');
    expect(params.lastRangeIdsRef.current).toEqual(['b', 'c']);
  });

  it('uses default focus and skips movement if both IDs are null', () => {
    const ev = event('j', true);
    const { params } = rangeParams({ focusedCardId: null, getDefaultFocusedCardId: () => null });
    handleRangeSelectionKey(ev.typed, params);
    expect(params.resolveMoveWithinLane).not.toHaveBeenCalled();
    expect(params.focusCardByKeyboard).not.toHaveBeenCalled();
  });

  it('does not focus when move resolution returns null', () => {
    const ev = event('j', true);
    const { params } = rangeParams({ resolveMoveWithinLane: () => null });
    handleRangeSelectionKey(ev.typed, params);
    expect(params.focusCardByKeyboard).not.toHaveBeenCalled();
  });

  it('always calls preventDefault, even when there is no current or default focus', () => {
    const ev = event('j', true);
    const { params } = rangeParams({ focusedCardId: null, getDefaultFocusedCardId: () => null });
    handleRangeSelectionKey(ev.typed, params);
    expect(ev.value.preventDefault).toHaveBeenCalledOnce();
  });

  it('falls back to the default focused card when nothing is focused', () => {
    const ev = event('j', true);
    const { params } = rangeParams({ focusedCardId: null, getDefaultFocusedCardId: () => 'a' });
    handleRangeSelectionKey(ev.typed, params);
    expect(params.resolveMoveWithinLane).toHaveBeenCalledWith('a', 'next');
  });

  it('initializes the range anchor to the current id even when move resolution returns null', () => {
    const ev = event('j', true);
    const { params } = rangeParams({ resolveMoveWithinLane: () => null });
    expect(params.rangeAnchorRef.current).toBeNull();
    handleRangeSelectionKey(ev.typed, params);
    expect(params.rangeAnchorRef.current).toBe('b');
  });

  it('preserves an existing range anchor instead of resetting it to the current id', () => {
    const ev = event('j', true);
    const { params, bulkSelection } = rangeParams();
    params.rangeAnchorRef.current = 'z';
    handleRangeSelectionKey(ev.typed, params);
    expect(params.rangeAnchorRef.current).toBe('z');
    expect(params.resolveMoveWithinLane).toHaveBeenCalledWith('b', 'next');
    expect(bulkSelection.selectRange).toHaveBeenCalledWith(['a', 'b', 'c'], 'z', 'c');
  });

  it('focuses the resolved card without touching selection when bulkSelection is null', () => {
    const ev = event('j', true);
    const { params } = rangeParams({ bulkSelection: null });
    handleRangeSelectionKey(ev.typed, params);
    expect(params.focusCardByKeyboard).toHaveBeenCalledWith('c');
  });

  it('does not call selectRange when the current card has no lane', () => {
    const ev = event('j', true);
    const { params, bulkSelection } = rangeParams({ findLaneForCard: () => null });
    handleRangeSelectionKey(ev.typed, params);
    expect(params.focusCardByKeyboard).toHaveBeenCalledWith('c');
    expect(bulkSelection.selectRange).not.toHaveBeenCalled();
  });

  it('removes ids that fall outside the new range from the selection', () => {
    const ev = event('j', true);
    const { params, bulkSelection } = rangeParams();
    params.lastRangeIdsRef.current = ['a'];
    handleRangeSelectionKey(ev.typed, params);
    // new range for anchor 'b' -> next 'c' within laneIds ['a','b','c'] is ['b','c'];
    // 'a' falls outside it and must be deselected.
    expect(bulkSelection.deselectAll).toHaveBeenCalledWith(['a']);
    expect(bulkSelection.selectRange).toHaveBeenCalledWith(['a', 'b', 'c'], 'b', 'c');
    expect(params.lastRangeIdsRef.current).toEqual(['b', 'c']);
  });

  it('does not call deselectAll when every previous id is still within the new range', () => {
    const ev = event('j', true);
    const { params, bulkSelection } = rangeParams();
    params.lastRangeIdsRef.current = ['b'];
    handleRangeSelectionKey(ev.typed, params);
    expect(bulkSelection.deselectAll).not.toHaveBeenCalled();
  });
});

describe('handleNormalMovementKey', () => {
  const run = (key: string, focusedCardId: string | null = 'b', defaultId: string | null = 'a') => {
    const ev = event(key);
    const params = {
      key, focusedCardId, getDefaultFocusedCardId: vi.fn(() => defaultId),
      focusCardByKeyboard: vi.fn(), moveWithinLane: vi.fn(), moveAcrossLanes: vi.fn(),
      resetRangeSelectionRefs: vi.fn(),
    };
    handleNormalMovementKey(ev.typed, params);
    return { ev, params };
  };

  it.each([
    ['ArrowDown', 'within', 'next'], ['j', 'within', 'next'], ['ArrowUp', 'within', 'prev'], ['k', 'within', 'prev'],
    ['ArrowRight', 'across', 'next'], ['l', 'across', 'next'], ['ArrowLeft', 'across', 'prev'], ['h', 'across', 'prev'],
    ['Home', 'within', 'first'], ['End', 'within', 'last'],
  ] as const)('routes %s to the expected movement', (key, kind, direction) => {
    const { ev, params } = run(key);
    expect(ev.value.preventDefault).toHaveBeenCalledOnce();
    expect(params.resetRangeSelectionRefs).toHaveBeenCalledOnce();
    if (kind === 'within') expect(params.moveWithinLane).toHaveBeenCalledWith(direction);
    else expect(params.moveAcrossLanes).toHaveBeenCalledWith(direction);
  });

  it('focuses default card only for navigation keys', () => {
    const navigation = run('ArrowDown', null);
    expect(navigation.ev.value.preventDefault).toHaveBeenCalledOnce();
    expect(navigation.params.focusCardByKeyboard).toHaveBeenCalledWith('a');
    expect(run('q', null).params.focusCardByKeyboard).not.toHaveBeenCalled();
    expect(run('j', null, null).params.focusCardByKeyboard).not.toHaveBeenCalled();
  });

  it('ignores non-navigation keys when focused', () => {
    const { ev, params } = run('q');
    expect(ev.value.preventDefault).not.toHaveBeenCalled();
    expect(params.resetRangeSelectionRefs).not.toHaveBeenCalled();
  });
});
