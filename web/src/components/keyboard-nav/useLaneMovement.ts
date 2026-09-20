// bdboard-sso1.39: BoardKeyboardNavProvider.tsx から、レーン内/レーン間の
// フォーカス移動 (j/k/h/l・矢印キー・Home/End が最終的に呼ぶ処理) を
// move-only で切り出したフック。挙動は元の実装と同一。
import { useCallback, type RefObject } from 'react';
import { type Lane } from '../../api';
import { resolveIndexAfterMove } from './laneLookup';

export interface LaneMovement {
  readonly resolveMoveWithinLane: (
    currentId: string,
    direction: 'next' | 'prev',
  ) => string | null;
  readonly moveWithinLane: (
    direction: 'next' | 'prev' | 'first' | 'last',
  ) => void;
  readonly moveAcrossLanes: (direction: 'next' | 'prev') => void;
}

export interface UseLaneMovementParams {
  readonly laneCardsRef: RefObject<Map<Lane, readonly string[]>>;
  readonly findLaneForCard: (cardId: string) => Lane | null;
  readonly getNonEmptyLanes: () => Lane[];
  readonly getDefaultFocusedCardId: () => string | null;
  readonly focusedCardId: string | null;
  readonly focusCardByKeyboard: (cardId: string | null) => void;
  readonly lastFocusedCardByLaneRef: RefObject<Map<Lane, string>>;
}

export function useLaneMovement({
  laneCardsRef,
  findLaneForCard,
  getNonEmptyLanes,
  getDefaultFocusedCardId,
  focusedCardId,
  focusCardByKeyboard,
  lastFocusedCardByLaneRef,
}: UseLaneMovementParams): LaneMovement {
  const resolveMoveWithinLane = useCallback(
    (currentId: string, direction: 'next' | 'prev'): string | null => {
      const lane = findLaneForCard(currentId);
      if (lane === null) {
        return null;
      }

      const ids = laneCardsRef.current.get(lane);
      if (ids === undefined || ids.length === 0) {
        return null;
      }

      return resolveIndexAfterMove(ids, currentId, direction);
    },
    [findLaneForCard, laneCardsRef],
  );

  const moveWithinLane = useCallback(
    (direction: 'next' | 'prev' | 'first' | 'last') => {
      const currentId = focusedCardId ?? getDefaultFocusedCardId();
      if (currentId === null) {
        return;
      }

      if (direction === 'next' || direction === 'prev') {
        const nextId = resolveMoveWithinLane(currentId, direction);
        if (nextId !== null) {
          focusCardByKeyboard(nextId);
        }
        return;
      }

      const lane = findLaneForCard(currentId);
      if (lane === null) {
        focusCardByKeyboard(getDefaultFocusedCardId());
        return;
      }

      const ids = laneCardsRef.current.get(lane);
      if (ids === undefined || ids.length === 0) {
        focusCardByKeyboard(getDefaultFocusedCardId());
        return;
      }

      const currentIndex = ids.indexOf(currentId);
      if (currentIndex === -1) {
        focusCardByKeyboard(getDefaultFocusedCardId());
        return;
      }

      const nextIndex = direction === 'first' ? 0 : ids.length - 1;
      focusCardByKeyboard(ids[nextIndex]!);
    },
    [
      findLaneForCard,
      focusCardByKeyboard,
      focusedCardId,
      getDefaultFocusedCardId,
      laneCardsRef,
      resolveMoveWithinLane,
    ],
  );

  const moveAcrossLanes = useCallback(
    (direction: 'next' | 'prev') => {
      const currentId = focusedCardId ?? getDefaultFocusedCardId();
      if (currentId === null) {
        focusCardByKeyboard(getDefaultFocusedCardId());
        return;
      }

      const currentLane = findLaneForCard(currentId);
      if (currentLane === null) {
        focusCardByKeyboard(getDefaultFocusedCardId());
        return;
      }

      const nonEmptyLanes = getNonEmptyLanes();
      const currentLaneIndex = nonEmptyLanes.indexOf(currentLane);
      if (currentLaneIndex === -1) {
        focusCardByKeyboard(getDefaultFocusedCardId());
        return;
      }

      const currentLaneIds = laneCardsRef.current.get(currentLane);
      const currentIndex =
        currentLaneIds !== undefined ? currentLaneIds.indexOf(currentId) : 0;

      const targetLaneIndex =
        direction === 'next' ? currentLaneIndex + 1 : currentLaneIndex - 1;
      if (targetLaneIndex < 0 || targetLaneIndex >= nonEmptyLanes.length) {
        return;
      }

      const targetLane = nonEmptyLanes[targetLaneIndex]!;
      const targetLaneIds = laneCardsRef.current.get(targetLane);
      if (targetLaneIds === undefined || targetLaneIds.length === 0) {
        return;
      }

      const rememberedCardId =
        lastFocusedCardByLaneRef.current.get(targetLane);
      let targetCardId: string;
      if (
        rememberedCardId !== undefined &&
        targetLaneIds.includes(rememberedCardId)
      ) {
        targetCardId = rememberedCardId;
      } else {
        const targetIndex = Math.min(
          Math.max(currentIndex, 0),
          targetLaneIds.length - 1,
        );
        targetCardId = targetLaneIds[targetIndex]!;
      }
      focusCardByKeyboard(targetCardId);
    },
    [
      findLaneForCard,
      focusCardByKeyboard,
      focusedCardId,
      getDefaultFocusedCardId,
      getNonEmptyLanes,
      laneCardsRef,
      lastFocusedCardByLaneRef,
    ],
  );

  return { resolveMoveWithinLane, moveWithinLane, moveAcrossLanes };
}
