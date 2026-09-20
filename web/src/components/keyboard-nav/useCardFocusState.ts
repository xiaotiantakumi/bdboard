// bdboard-sso1.39: BoardKeyboardNavProvider.tsx から、フォーカス中カードの
// state・DOM 要素登録・DOM フォーカス同期・CardItem 向け props 組み立てを
// move-only で切り出したフック。挙動は元の実装と同一（PR 本文の effect
// 不変条件の表を参照 — ここに残る2つの useEffect が、分割前と同じ相対順序
// (効果1→効果2) のまま隣接して呼ばれる）。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { type Lane } from '../../api';
import type { CardNavProps } from './types';

export interface CardFocusState {
  readonly focusedCardId: string | null;
  readonly rememberLaneFocus: (cardId: string) => void;
  readonly focusCardByKeyboard: (cardId: string | null) => void;
  readonly getCardNavProps: (lane: Lane, cardId: string) => CardNavProps;
  /** moveAcrossLanes (useLaneMovement) が h/l 復帰用に読む、共有 ref */
  readonly lastFocusedCardByLaneRef: RefObject<Map<Lane, string>>;
}

export interface UseCardFocusStateParams {
  readonly laneRegistryVersion: number;
  readonly findLaneForCard: (cardId: string) => Lane | null;
  readonly getDefaultFocusedCardId: () => string | null;
  readonly resetRangeSelectionRefs: () => void;
}

export function useCardFocusState({
  laneRegistryVersion,
  findLaneForCard,
  getDefaultFocusedCardId,
  resetRangeSelectionRefs,
}: UseCardFocusStateParams): CardFocusState {
  const cardElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  /** レーンごとに最後にフォーカスしていたカード ID（h/l で戻るときに復帰） */
  const lastFocusedCardByLaneRef = useRef<Map<Lane, string>>(new Map());
  const pendingFocusRef = useRef(false);
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);

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

  return {
    focusedCardId,
    rememberLaneFocus,
    focusCardByKeyboard,
    getCardNavProps,
    lastFocusedCardByLaneRef,
  };
}
