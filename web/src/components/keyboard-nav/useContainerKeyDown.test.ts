import { createRef } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Lane } from '../../api';
import type { BulkSelectionContextValue } from '../BulkSelectionProvider';
import { useContainerKeyDown, type UseContainerKeyDownParams } from './useContainerKeyDown';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

function setup(overrides: Partial<UseContainerKeyDownParams> = {}) {
  const bulkSelection: BulkSelectionContextValue = {
    selectedIds: new Set(['selected']), isSelected: vi.fn(), toggle: vi.fn(),
    selectRange: vi.fn(), deselectAll: vi.fn(), clear: vi.fn(),
  };
  const rangeAnchorRef = createRef<string | null>();
  rangeAnchorRef.current = null;
  const lastRangeIdsRef = createRef<readonly string[]>() as RefObject<readonly string[]>;
  lastRangeIdsRef.current = [];
  const params: UseContainerKeyDownParams = {
    bulkSelection, focusedCardId: 'b', getDefaultFocusedCardId: vi.fn(() => 'a'),
    findLaneForCard: vi.fn(() => 'lane' as unknown as Lane),
    laneCardsRef: { current: new Map([['lane' as unknown as Lane, ['a', 'b', 'c']]]) },
    resolveMoveWithinLane: vi.fn(() => 'c'), focusCardByKeyboard: vi.fn(),
    moveWithinLane: vi.fn(), moveAcrossLanes: vi.fn(), rangeAnchorRef, lastRangeIdsRef,
    resetRangeSelectionRefs: vi.fn(), ...overrides,
  };
  const { result } = renderHook(() => useContainerKeyDown(params));
  const handler = result.current;
  const call = (key: string, shiftKey = false, defaultPrevented = false) => {
    const event = { key, shiftKey, target: { tagName: 'DIV' }, defaultPrevented, preventDefault: vi.fn() };
    handler(event as unknown as ReactKeyboardEvent<HTMLElement>);
    return event;
  };
  return { params, call, bulkSelection, rangeAnchorRef, lastRangeIdsRef };
}

describe('useContainerKeyDown', () => {
  it('ignores events that already have defaultPrevented set (shouldIgnoreContainerKeydown guard)', () => {
    const { call, params } = setup();
    const event = call('ArrowDown', false, true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(params.moveWithinLane).not.toHaveBeenCalled();
  });

  it('clears a non-empty selection on Escape', () => {
    const { call, params, bulkSelection } = setup();
    const event = call('Escape');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(bulkSelection.clear).toHaveBeenCalledOnce();
    expect(params.resetRangeSelectionRefs).toHaveBeenCalledOnce();
  });

  it.each([
    ['empty selection', { selectedIds: new Set<string>() }],
    ['null selection', null],
  ])('does nothing on Escape with %s', (_label, selection) => {
    const { call, params } = setup({ bulkSelection: selection as BulkSelectionContextValue | null });
    const event = call('Escape');
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(params.resetRangeSelectionRefs).not.toHaveBeenCalled();
  });

  it.each(['x', 'X'])('toggles focused card for %s without shift', (key) => {
    const { call, bulkSelection, rangeAnchorRef, lastRangeIdsRef } = setup();
    const event = call(key);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(bulkSelection.toggle).toHaveBeenCalledWith('b');
    expect(rangeAnchorRef.current).toBe('b');
    expect(lastRangeIdsRef.current).toEqual([]);
  });

  it('does nothing for x-toggle without a focused card or selection', () => {
    const noFocus = setup({ focusedCardId: null });
    expect(noFocus.call('x').preventDefault).not.toHaveBeenCalled();
    const noSelection = setup({ bulkSelection: null });
    expect(noSelection.call('x').preventDefault).not.toHaveBeenCalled();
  });

  it.each([['ArrowDown', 'next'], ['j', 'next'], ['ArrowUp', 'prev'], ['k', 'prev']] as const)(
    'selects and focuses a Shift range for %s', (key, direction) => {
      const { call, params, bulkSelection, lastRangeIdsRef } = setup();
      const event = call(key, true);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(params.resolveMoveWithinLane).toHaveBeenCalledWith('b', direction);
      expect(params.focusCardByKeyboard).toHaveBeenCalledWith('c');
      expect(bulkSelection.selectRange).toHaveBeenCalledWith(['a', 'b', 'c'], 'b', 'c');
      expect(lastRangeIdsRef.current).toEqual(['b', 'c']);
    },
  );

  it('does nothing when neither focused nor default card exists during range selection', () => {
    const { call, params } = setup({ focusedCardId: null, getDefaultFocusedCardId: () => null });
    const event = call('j', true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(params.resolveMoveWithinLane).not.toHaveBeenCalled();
    expect(params.focusCardByKeyboard).not.toHaveBeenCalled();
  });

  it('falls back to the default focused card during range selection when nothing is focused', () => {
    const { call, params } = setup({ focusedCardId: null, getDefaultFocusedCardId: () => 'a' });
    call('j', true);
    expect(params.resolveMoveWithinLane).toHaveBeenCalledWith('a', 'next');
  });

  it('does not focus when range movement cannot resolve a next card', () => {
    const { call, params } = setup({ resolveMoveWithinLane: () => null });
    call('j', true);
    expect(params.focusCardByKeyboard).not.toHaveBeenCalled();
  });

  it('ignores shifted unrelated keys', () => {
    const { call, params } = setup();
    const event = call('q', true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(params.moveWithinLane).not.toHaveBeenCalled();
  });

  it.each(['x', 'X'])('does not toggle selection for shifted %s (x-toggle requires !shift)', (key) => {
    const { call, bulkSelection } = setup();
    const event = call(key, true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(bulkSelection.toggle).not.toHaveBeenCalled();
  });

  it.each(['ArrowRight', 'l', 'ArrowLeft', 'h', 'Home', 'End'])(
    'does not move across/within lanes for shifted %s (only next/prev-in-lane keys trigger range selection)',
    (key) => {
      const { call, params } = setup();
      const event = call(key, true);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(params.moveAcrossLanes).not.toHaveBeenCalled();
      expect(params.moveWithinLane).not.toHaveBeenCalled();
    },
  );

  it.each(['ArrowDown', 'j', 'ArrowUp', 'k', 'ArrowRight', 'l', 'ArrowLeft', 'h', 'Home', 'End'])(
    'focuses the default card with %s when there is no current focus',
    (key) => {
      const { call, params } = setup({ focusedCardId: null });
      call(key);
      expect(params.focusCardByKeyboard).toHaveBeenCalledWith('a');
    },
  );

  it('does not focus a default card for unrelated keys or when no default exists', () => {
    const unrelated = setup({ focusedCardId: null });
    unrelated.call('q');
    expect(unrelated.params.focusCardByKeyboard).not.toHaveBeenCalled();
    const noDefault = setup({ focusedCardId: null, getDefaultFocusedCardId: () => null });
    noDefault.call('j');
    expect(noDefault.params.focusCardByKeyboard).not.toHaveBeenCalled();
  });

  it.each([
    ['ArrowDown', 'next', 'within'], ['j', 'next', 'within'], ['ArrowUp', 'prev', 'within'], ['k', 'prev', 'within'],
    ['ArrowRight', 'next', 'across'], ['l', 'next', 'across'], ['ArrowLeft', 'prev', 'across'], ['h', 'prev', 'across'],
    ['Home', 'first', 'within'], ['End', 'last', 'within'],
  ] as const)('moves normally for %s', (key, direction, kind) => {
    const { call, params } = setup();
    const event = call(key);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(params.resetRangeSelectionRefs).toHaveBeenCalledOnce();
    if (kind === 'within') expect(params.moveWithinLane).toHaveBeenCalledWith(direction);
    else expect(params.moveAcrossLanes).toHaveBeenCalledWith(direction);
  });

  it('ignores unrelated normal keys', () => {
    const { call, params } = setup();
    const event = call('q');
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(params.resetRangeSelectionRefs).not.toHaveBeenCalled();
  });
});
