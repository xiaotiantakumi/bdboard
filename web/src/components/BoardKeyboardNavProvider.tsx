import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { LANES, type Lane } from '../api';
import {
  idsInInclusiveRange,
  useBulkSelection,
} from './BulkSelectionProvider';

export interface CardNavProps {
  tabIndex: number;
  ariaSelected: boolean;
  onFocus: () => void;
  cardRef: (el: HTMLElement | null) => void;
}

export interface BoardKeyboardNavContextValue {
  /** LaneColumn が描画中のカード ID を登録する。ids が変わるたびに呼ぶ */
  registerLane: (lane: Lane, ids: readonly string[]) => void;
  unregisterLane: (lane: Lane) => void;
  /** CardItem に渡す props を組み立てる */
  getCardNavProps: (lane: Lane, cardId: string) => CardNavProps;
  /** コンテナ（.lanes-row）に付ける keydown ハンドラ */
  onContainerKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

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
 */
export function BoardKeyboardNavProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const laneCardsRef = useRef<Map<Lane, readonly string[]>>(new Map());
  const cardElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  /** レーンごとに最後にフォーカスしていたカード ID（h/l で戻るときに復帰） */
  const lastFocusedCardByLaneRef = useRef<Map<Lane, string>>(new Map());
  const pendingFocusRef = useRef(false);
  /** Shift+j/k 範囲選択のアンカー。通常の j/k 移動でリセットする */
  const rangeAnchorRef = useRef<string | null>(null);
  /** 直前の Shift+j/k で選択した範囲（行き過ぎ補正用） */
  const lastRangeIdsRef = useRef<readonly string[]>([]);

  const resetRangeSelectionRefs = () => {
    rangeAnchorRef.current = null;
    lastRangeIdsRef.current = [];
  };
  const [laneRegistryVersion, bumpLaneRegistry] = useState(0);
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const bulkSelection = useBulkSelection();

  const registerLane = useCallback((lane: Lane, ids: readonly string[]) => {
    laneCardsRef.current.set(lane, ids);
    bumpLaneRegistry((version) => version + 1);
  }, []);

  const unregisterLane = useCallback((lane: Lane) => {
    laneCardsRef.current.delete(lane);
    // レーン内容が変わるたびに unregister→register が走るため、ここで記憶を消すと
    // 記憶がほぼ毎回失われる。古い記憶は moveAcrossLanes の存在チェックで無効化する。
    bumpLaneRegistry((version) => version + 1);
  }, []);

  const getNonEmptyLanes = useCallback((): Lane[] => {
    return LANES.filter((lane) => {
      const ids = laneCardsRef.current.get(lane);
      return ids !== undefined && ids.length > 0;
    });
  }, []);

  const findLaneForCard = useCallback((cardId: string): Lane | null => {
    for (const lane of LANES) {
      const ids = laneCardsRef.current.get(lane);
      if (ids !== undefined && ids.includes(cardId)) {
        return lane;
      }
    }
    return null;
  }, []);

  const getDefaultFocusedCardId = useCallback((): string | null => {
    const lanes = getNonEmptyLanes();
    if (lanes.length === 0) {
      return null;
    }
    const firstLane = lanes[0]!;
    const ids = laneCardsRef.current.get(firstLane);
    return ids !== undefined && ids.length > 0 ? ids[0]! : null;
  }, [getNonEmptyLanes]);

  const rememberLaneFocus = useCallback(
    (cardId: string) => {
      const lane = findLaneForCard(cardId);
      if (lane !== null) {
        lastFocusedCardByLaneRef.current.set(lane, cardId);
      }
    },
    [findLaneForCard],
  );

  const focusCardByKeyboard = useCallback(
    (cardId: string | null) => {
      pendingFocusRef.current = true;
      if (cardId !== null) {
        rememberLaneFocus(cardId);
      }
      setFocusedCardId(cardId);
    },
    [rememberLaneFocus],
  );

  useEffect(() => {
    if (focusedCardId === null) {
      return;
    }
    const lane = findLaneForCard(focusedCardId);
    if (lane === null) {
      setFocusedCardId(null);
    }
  }, [findLaneForCard, focusedCardId, laneRegistryVersion]);

  useEffect(() => {
    if (!pendingFocusRef.current || focusedCardId === null) {
      return;
    }
    const el = cardElementsRef.current.get(focusedCardId);
    if (el !== undefined) {
      el.focus();
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
    pendingFocusRef.current = false;
  }, [focusedCardId]);

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

      const currentIndex = ids.indexOf(currentId);
      if (currentIndex === -1) {
        return null;
      }

      let nextIndex = currentIndex;
      switch (direction) {
        case 'next':
          nextIndex = Math.min(currentIndex + 1, ids.length - 1);
          break;
        case 'prev':
          nextIndex = Math.max(currentIndex - 1, 0);
          break;
      }

      return ids[nextIndex] ?? null;
    },
    [findLaneForCard],
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

      const rememberedCardId = lastFocusedCardByLaneRef.current.get(targetLane);
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
    [findLaneForCard, focusCardByKeyboard, focusedCardId, getDefaultFocusedCardId, getNonEmptyLanes],
  );

  const onContainerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }

      const key = event.key;
      const shift = event.shiftKey;
      const isNextInLane = key === 'ArrowDown' || key === 'j';
      const isPrevInLane = key === 'ArrowUp' || key === 'k';

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
      moveAcrossLanes,
      moveWithinLane,
      resolveMoveWithinLane,
    ],
  );

  const defaultFocusedCardId = useMemo(
    () => getDefaultFocusedCardId(),
    [getDefaultFocusedCardId, laneRegistryVersion],
  );

  const getCardNavProps = useCallback(
    (_lane: Lane, cardId: string): CardNavProps => {
      const isFocused = focusedCardId === cardId;
      const isDefaultTabStop =
        focusedCardId === null &&
        defaultFocusedCardId !== null &&
        defaultFocusedCardId === cardId;

      return {
        tabIndex: isFocused || isDefaultTabStop ? 0 : -1,
        ariaSelected: isFocused,
        onFocus: () => {
          rememberLaneFocus(cardId);
          setFocusedCardId(cardId);
          // キーボード移動(focusCardByKeyboard)由来の focus ではアンカーを維持する
          if (!pendingFocusRef.current) {
            resetRangeSelectionRefs();
          }
        },
        cardRef: (el: HTMLElement | null) => {
          if (el === null) {
            cardElementsRef.current.delete(cardId);
            return;
          }
          cardElementsRef.current.set(cardId, el);
        },
      };
    },
    [defaultFocusedCardId, focusedCardId, rememberLaneFocus],
  );

  const contextValue = useMemo(
    (): BoardKeyboardNavContextValue => ({
      registerLane,
      unregisterLane,
      getCardNavProps,
      onContainerKeyDown,
    }),
    [getCardNavProps, onContainerKeyDown, registerLane, unregisterLane],
  );

  return (
    <BoardKeyboardNavContext.Provider value={contextValue}>
      {children}
    </BoardKeyboardNavContext.Provider>
  );
}
