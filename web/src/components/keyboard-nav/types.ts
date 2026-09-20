// bdboard-sso1.39: BoardKeyboardNavProvider.tsx の公開型を move-only で
// 切り出しただけのファイル。挙動には関与しない（型のみ）。
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Lane } from '../../api';

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
