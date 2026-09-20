// bdboard-sso1.39: BoardKeyboardNavProvider.tsx から、レーン登録 Map
// (laneCards) を読むだけの純ロジック・次フォーカス位置の計算を move-only で
// 切り出したファイル。React state/ref には一切触れない（呼び出し側が
// laneCardsRef.current やレーン内 ids 配列を渡す）。
import { LANES, type Lane } from '../../api';

/** カードが1件以上登録されているレーンを LANES の順序で返す */
export function getNonEmptyLanesFor(
  laneCards: ReadonlyMap<Lane, readonly string[]>,
): Lane[] {
  return LANES.filter((lane) => {
    const ids = laneCards.get(lane);
    return ids !== undefined && ids.length > 0;
  });
}

/** cardId が属するレーンを探す。見つからなければ null */
export function findLaneForCardIn(
  laneCards: ReadonlyMap<Lane, readonly string[]>,
  cardId: string,
): Lane | null {
  for (const lane of LANES) {
    const ids = laneCards.get(lane);
    if (ids !== undefined && ids.includes(cardId)) {
      return lane;
    }
  }
  return null;
}

/**
 * レーン内移動の次フォーカス位置の計算。ids は対象レーンの並び順、
 * direction は j/k・ArrowDown/ArrowUp が表す方向。端では止まる
 * (ラップアラウンドしない)。
 */
export function resolveIndexAfterMove(
  ids: readonly string[],
  currentId: string,
  direction: 'next' | 'prev',
): string | null {
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
}
