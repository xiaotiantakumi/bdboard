// bdboard-sso1.39: BoardKeyboardNavProvider.tsx から、コンテナ (.lanes-row)
// の keydown ハンドラ本体 (キー→操作の解釈) を move-only で切り出したフック。
// 対象外イベント判定・方向キー判定の純ロジックは keyClassification.ts。
// 挙動は元の実装と同一。
import {
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { type Lane } from '../../api';
import {
  idsInInclusiveRange,
  type BulkSelectionContextValue,
} from '../BulkSelectionProvider';
import {
  isNextInLaneKey,
  isPrevInLaneKey,
  shouldIgnoreContainerKeydown,
} from './keyClassification';

export interface UseContainerKeyDownParams {
  readonly bulkSelection: BulkSelectionContextValue | null;
  readonly focusedCardId: string | null;
  readonly getDefaultFocusedCardId: () => string | null;
  readonly findLaneForCard: (cardId: string) => Lane | null;
  readonly laneCardsRef: RefObject<Map<Lane, readonly string[]>>;
  readonly resolveMoveWithinLane: (
    currentId: string,
    direction: 'next' | 'prev',
  ) => string | null;
  readonly focusCardByKeyboard: (cardId: string | null) => void;
  readonly moveWithinLane: (
    direction: 'next' | 'prev' | 'first' | 'last',
  ) => void;
  readonly moveAcrossLanes: (direction: 'next' | 'prev') => void;
  readonly rangeAnchorRef: RefObject<string | null>;
  readonly lastRangeIdsRef: RefObject<readonly string[]>;
  readonly resetRangeSelectionRefs: () => void;
}

export function useContainerKeyDown({
  bulkSelection,
  focusedCardId,
  getDefaultFocusedCardId,
  findLaneForCard,
  laneCardsRef,
  resolveMoveWithinLane,
  focusCardByKeyboard,
  moveWithinLane,
  moveAcrossLanes,
  rangeAnchorRef,
  lastRangeIdsRef,
  resetRangeSelectionRefs,
}: UseContainerKeyDownParams): (
  event: ReactKeyboardEvent<HTMLElement>,
) => void {
  return useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (shouldIgnoreContainerKeydown(event)) {
        return;
      }

      const key = event.key;
      const shift = event.shiftKey;
      const isNextInLane = isNextInLaneKey(key);
      const isPrevInLane = isPrevInLaneKey(key);

      if (
        key === 'Escape' &&
        bulkSelection !== null &&
        bulkSelection.selectedIds.size > 0
      ) {
        event.preventDefault();
        bulkSelection.clear();
        resetRangeSelectionRefs();
        return;
      }

      if ((key === 'x' || key === 'X') && !shift) {
        if (focusedCardId !== null && bulkSelection !== null) {
          event.preventDefault();
          bulkSelection.toggle(focusedCardId);
          rangeAnchorRef.current = focusedCardId;
          lastRangeIdsRef.current = [];
        }
        return;
      }

      if (shift && (isNextInLane || isPrevInLane)) {
        event.preventDefault();
        const currentId = focusedCardId ?? getDefaultFocusedCardId();
        if (currentId === null) {
          return;
        }

        const direction = isNextInLane ? 'next' : 'prev';
        const anchor = rangeAnchorRef.current ?? currentId;
        rangeAnchorRef.current = anchor;
        const nextId = resolveMoveWithinLane(currentId, direction);
        if (nextId === null) {
          return;
        }

        focusCardByKeyboard(nextId);

        if (bulkSelection !== null) {
          const lane = findLaneForCard(currentId);
          const laneIds =
            lane !== null ? laneCardsRef.current.get(lane) : undefined;
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
        return;
      }

      if (shift) {
        return;
      }

      if (focusedCardId === null) {
        const defaultId = getDefaultFocusedCardId();
        if (defaultId === null) {
          return;
        }
        if (
          key === 'ArrowDown' ||
          key === 'j' ||
          key === 'ArrowUp' ||
          key === 'k' ||
          key === 'ArrowRight' ||
          key === 'l' ||
          key === 'ArrowLeft' ||
          key === 'h' ||
          key === 'Home' ||
          key === 'End'
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
    },
    [
      bulkSelection,
      findLaneForCard,
      focusCardByKeyboard,
      focusedCardId,
      getDefaultFocusedCardId,
      laneCardsRef,
      lastRangeIdsRef,
      moveAcrossLanes,
      moveWithinLane,
      rangeAnchorRef,
      resolveMoveWithinLane,
      resetRangeSelectionRefs,
    ],
  );
}
