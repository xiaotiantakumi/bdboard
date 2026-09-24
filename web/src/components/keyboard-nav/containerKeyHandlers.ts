import { type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { type Lane } from '../../api';
import { idsInInclusiveRange, type BulkSelectionContextValue } from '../BulkSelectionProvider';

export interface EscapeKeyParams {
  readonly bulkSelection: BulkSelectionContextValue | null;
  readonly resetRangeSelectionRefs: () => void;
}

export function handleEscapeKey(
  event: ReactKeyboardEvent<HTMLElement>,
  params: EscapeKeyParams,
): boolean {
  const { bulkSelection, resetRangeSelectionRefs } = params;
  if (bulkSelection !== null && bulkSelection.selectedIds.size > 0) {
    event.preventDefault();
    bulkSelection.clear();
    resetRangeSelectionRefs();
    return true;
  }
  return false;
}

export interface ToggleSelectionKeyParams {
  readonly bulkSelection: BulkSelectionContextValue | null;
  readonly focusedCardId: string | null;
  readonly rangeAnchorRef: RefObject<string | null>;
  readonly lastRangeIdsRef: RefObject<readonly string[]>;
}

export function handleToggleSelectionKey(
  event: ReactKeyboardEvent<HTMLElement>,
  params: ToggleSelectionKeyParams,
): void {
  const { bulkSelection, focusedCardId, rangeAnchorRef, lastRangeIdsRef } = params;
  if (focusedCardId !== null && bulkSelection !== null) {
    event.preventDefault();
    bulkSelection.toggle(focusedCardId);
    rangeAnchorRef.current = focusedCardId;
    lastRangeIdsRef.current = [];
  }
}

export interface RangeSelectionKeyParams {
  readonly direction: 'next' | 'prev';
  readonly bulkSelection: BulkSelectionContextValue | null;
  readonly focusedCardId: string | null;
  readonly getDefaultFocusedCardId: () => string | null;
  readonly findLaneForCard: (cardId: string) => Lane | null;
  readonly laneCardsRef: RefObject<Map<Lane, readonly string[]>>;
  readonly resolveMoveWithinLane: (currentId: string, direction: 'next' | 'prev') => string | null;
  readonly focusCardByKeyboard: (cardId: string | null) => void;
  readonly rangeAnchorRef: RefObject<string | null>;
  readonly lastRangeIdsRef: RefObject<readonly string[]>;
}

export function handleRangeSelectionKey(
  event: ReactKeyboardEvent<HTMLElement>,
  params: RangeSelectionKeyParams,
): void {
  const {
    direction, bulkSelection, focusedCardId, getDefaultFocusedCardId,
    findLaneForCard, laneCardsRef, resolveMoveWithinLane, focusCardByKeyboard,
    rangeAnchorRef, lastRangeIdsRef,
  } = params;
  event.preventDefault();
  const currentId = focusedCardId ?? getDefaultFocusedCardId();
  if (currentId === null) {
    return;
  }

  const anchor = rangeAnchorRef.current ?? currentId;
  rangeAnchorRef.current = anchor;
  const nextId = resolveMoveWithinLane(currentId, direction);
  if (nextId === null) {
    return;
  }

  focusCardByKeyboard(nextId);

  if (bulkSelection !== null) {
    const lane = findLaneForCard(currentId);
    const laneIds = lane !== null ? laneCardsRef.current.get(lane) : undefined;
    if (laneIds !== undefined) {
      const newRange = idsInInclusiveRange(laneIds, anchor, nextId);
      const idsToRemove = lastRangeIdsRef.current.filter(
        (id) => !newRange.includes(id),
      );
      if (idsToRemove.length > 0) {
        bulkSelection.deselectAll(idsToRemove);
      }
      bulkSelection.selectRange(laneIds, anchor, nextId);
      lastRangeIdsRef.current = newRange;
    }
  }
}

export interface NormalMovementKeyParams {
  readonly key: string;
  readonly focusedCardId: string | null;
  readonly getDefaultFocusedCardId: () => string | null;
  readonly focusCardByKeyboard: (cardId: string | null) => void;
  readonly moveWithinLane: (direction: 'next' | 'prev' | 'first' | 'last') => void;
  readonly moveAcrossLanes: (direction: 'next' | 'prev') => void;
  readonly resetRangeSelectionRefs: () => void;
}

export function handleNormalMovementKey(
  event: ReactKeyboardEvent<HTMLElement>,
  params: NormalMovementKeyParams,
): void {
  const {
    key, focusedCardId, getDefaultFocusedCardId, focusCardByKeyboard,
    moveWithinLane, moveAcrossLanes, resetRangeSelectionRefs,
  } = params;
  if (focusedCardId === null) {
    const defaultId = getDefaultFocusedCardId();
    if (defaultId === null) {
      return;
    }
    if (
      key === 'ArrowDown' || key === 'j' || key === 'ArrowUp' || key === 'k' ||
      key === 'ArrowRight' || key === 'l' || key === 'ArrowLeft' || key === 'h' ||
      key === 'Home' || key === 'End'
    ) {
      event.preventDefault();
      focusCardByKeyboard(defaultId);
    }
    return;
  }

  switch (key) {
    case 'ArrowDown':
    case 'j':
      event.preventDefault();
      resetRangeSelectionRefs();
      moveWithinLane('next');
      break;
    case 'ArrowUp':
    case 'k':
      event.preventDefault();
      resetRangeSelectionRefs();
      moveWithinLane('prev');
      break;
    case 'ArrowRight':
    case 'l':
      event.preventDefault();
      resetRangeSelectionRefs();
      moveAcrossLanes('next');
      break;
    case 'ArrowLeft':
    case 'h':
      event.preventDefault();
      resetRangeSelectionRefs();
      moveAcrossLanes('prev');
      break;
    case 'Home':
      event.preventDefault();
      resetRangeSelectionRefs();
      moveWithinLane('first');
      break;
    case 'End':
      event.preventDefault();
      resetRangeSelectionRefs();
      moveWithinLane('last');
      break;
    default:
      break;
  }
}
