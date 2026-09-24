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
import type { BulkSelectionContextValue } from '../BulkSelectionProvider';
import {
  handleEscapeKey,
  handleNormalMovementKey,
  handleRangeSelectionKey,
  handleToggleSelectionKey,
} from './containerKeyHandlers';
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

      if (key === 'Escape') {
        const handled = handleEscapeKey(event, { bulkSelection, resetRangeSelectionRefs });
        if (handled) return;
      }

      if ((key === 'x' || key === 'X') && !shift) {
        handleToggleSelectionKey(event, { bulkSelection, focusedCardId, rangeAnchorRef, lastRangeIdsRef });
        return;
      }

      if (shift && (isNextInLane || isPrevInLane)) {
        handleRangeSelectionKey(event, {
          direction: isNextInLane ? 'next' : 'prev',
          bulkSelection, focusedCardId, getDefaultFocusedCardId, findLaneForCard,
          laneCardsRef, resolveMoveWithinLane, focusCardByKeyboard, rangeAnchorRef, lastRangeIdsRef,
        });
        return;
      }

      if (shift) return;

      handleNormalMovementKey(event, {
        key, focusedCardId, getDefaultFocusedCardId, focusCardByKeyboard,
        moveWithinLane, moveAcrossLanes, resetRangeSelectionRefs,
      });
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
    ],
  );
}
