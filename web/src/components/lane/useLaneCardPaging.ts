import { useEffect, useState } from 'react';
import type { BoardCardDto, Lane } from '../../api';
import { useBoardKeyboardNav } from '../BoardKeyboardNavProvider';
import { PAGE_SIZE } from './constants';

export interface UseLaneCardPagingResult {
  visibleCards: BoardCardDto[];
  remaining: number;
  showMore: () => void;
}

/**
 * レーン内カードのページング(表示件数の追加読み込み)と、キーボードナビ
 * provider への登録を束ねるフック。両者は idsKey(表示中カードIDの結合文字列)
 * を介して結合しているため、まとめて1フックにする(bdboard-sso1.33 PR-C)。
 */
export function useLaneCardPaging(
  lane: Lane,
  cards: BoardCardDto[],
  collapsed: boolean,
): UseLaneCardPagingResult {
  const boardNav = useBoardKeyboardNav();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const visibleCards = cards.slice(0, visibleCount);
  const visibleCardIds = visibleCards.map((card) => card.ticket.id);
  const idsKey = visibleCardIds.join(',');
  const remaining = cards.length - visibleCount;

  // registerLane/unregisterLane は provider 側で useCallback により参照安定。
  // boardNav 自体を依存に入れるとフォーカス移動のたびに context 値の identity が
  // 変わり、全レーンが unregister→register を繰り返すので、関数だけを依存にする。
  const registerLane = boardNav?.registerLane;
  const unregisterLane = boardNav?.unregisterLane;

  useEffect(() => {
    if (registerLane === undefined || unregisterLane === undefined) {
      return;
    }
    // idsKey は visibleCardIds の内容キー。内容が同じ間は再登録不要なので、
    // visibleCardIds 自体は依存に入れない(毎レンダー新しい配列になるため)。
    registerLane(lane, collapsed ? [] : visibleCardIds);
    return () => {
      unregisterLane(lane);
    };
  }, [registerLane, unregisterLane, lane, idsKey, collapsed]);

  const showMore = () => setVisibleCount((count) => count + PAGE_SIZE);

  return { visibleCards, remaining, showMore };
}
