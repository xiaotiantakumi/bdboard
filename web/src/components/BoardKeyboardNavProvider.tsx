import {
  createContext,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useBulkSelection } from './BulkSelectionProvider';
import { useCardFocusState } from './keyboard-nav/useCardFocusState';
import { useContainerKeyDown } from './keyboard-nav/useContainerKeyDown';
import { useLaneMovement } from './keyboard-nav/useLaneMovement';
import { useLaneRegistry } from './keyboard-nav/useLaneRegistry';
import { useRangeSelectionRefs } from './keyboard-nav/useRangeSelectionRefs';
import type {
  BoardKeyboardNavContextValue,
  CardNavProps,
} from './keyboard-nav/types';

export type { CardNavProps, BoardKeyboardNavContextValue };

const BoardKeyboardNavContext =
  createContext<BoardKeyboardNavContextValue | null>(null);

export function useBoardKeyboardNav(): BoardKeyboardNavContextValue | null {
  return useContext(BoardKeyboardNavContext);
}

/**
 * ボード上のカードをキーボードで操作するための状態を束ねる。
 *
 * ここ (onContainerKeyDown) が担当するのは、レーン内/レーン間の移動
 * (j/k/h/l と矢印キー・Home/End)、選択トグル (x)、Shift+j/k の範囲選択、
 * Escape での選択解除。
 *
 * Enter/Space での「活性化」(詳細パネルを開く) だけはここではなく CardItem 側の
 * onClick / onKeyDown が担当する。カード内の★ウォッチや一括選択チェックボックスの
 * Enter/Space を奪わないためのガード (bdboard-4dl) が要素ローカルな判定を必要と
 * するため。以前は使われない onActivate prop がここに生えていて、活性化の担当箇所を
 * 読み違える元になっていた (bdboard-cqj)。
 *
 * bdboard-sso1.39: 純ロジック (keyboard-nav/laneLookup.ts,
 * keyClassification.ts) と関心別フック (keyboard-nav/useLaneRegistry.ts,
 * useRangeSelectionRefs.ts, useCardFocusState.ts, useLaneMovement.ts,
 * useContainerKeyDown.ts) へ move-only で分割した。ここに残るのは、各フックを
 * 呼び出してコンテキスト値を組み立てるだけの配線。呼び出し順は分割前の
 * フック呼び出し順と同数・同じ相対順序 (特に useEffect ×2 は
 * useCardFocusState 内に隣接したまま)。context の公開面・import パスは不変。
 */
export function BoardKeyboardNavProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const laneRegistry = useLaneRegistry();
  const bulkSelection = useBulkSelection();
  const rangeSelection = useRangeSelectionRefs();
  const cardFocus = useCardFocusState({
    laneRegistryVersion: laneRegistry.laneRegistryVersion,
    findLaneForCard: laneRegistry.findLaneForCard,
    getDefaultFocusedCardId: laneRegistry.getDefaultFocusedCardId,
    resetRangeSelectionRefs: rangeSelection.resetRangeSelectionRefs,
  });
  const laneMovement = useLaneMovement({
    laneCardsRef: laneRegistry.laneCardsRef,
    findLaneForCard: laneRegistry.findLaneForCard,
    getNonEmptyLanes: laneRegistry.getNonEmptyLanes,
    getDefaultFocusedCardId: laneRegistry.getDefaultFocusedCardId,
    focusedCardId: cardFocus.focusedCardId,
    focusCardByKeyboard: cardFocus.focusCardByKeyboard,
    lastFocusedCardByLaneRef: cardFocus.lastFocusedCardByLaneRef,
  });
  const onContainerKeyDown = useContainerKeyDown({
    bulkSelection,
    focusedCardId: cardFocus.focusedCardId,
    getDefaultFocusedCardId: laneRegistry.getDefaultFocusedCardId,
    findLaneForCard: laneRegistry.findLaneForCard,
    laneCardsRef: laneRegistry.laneCardsRef,
    resolveMoveWithinLane: laneMovement.resolveMoveWithinLane,
    focusCardByKeyboard: cardFocus.focusCardByKeyboard,
    moveWithinLane: laneMovement.moveWithinLane,
    moveAcrossLanes: laneMovement.moveAcrossLanes,
    rangeAnchorRef: rangeSelection.rangeAnchorRef,
    lastRangeIdsRef: rangeSelection.lastRangeIdsRef,
    resetRangeSelectionRefs: rangeSelection.resetRangeSelectionRefs,
  });

  const contextValue = useMemo(
    (): BoardKeyboardNavContextValue => ({
      registerLane: laneRegistry.registerLane,
      unregisterLane: laneRegistry.unregisterLane,
      getCardNavProps: cardFocus.getCardNavProps,
      onContainerKeyDown,
    }),
    [
      cardFocus.getCardNavProps,
      onContainerKeyDown,
      laneRegistry.registerLane,
      laneRegistry.unregisterLane,
    ],
  );

  return (
    <BoardKeyboardNavContext.Provider value={contextValue}>
      {children}
    </BoardKeyboardNavContext.Provider>
  );
}
