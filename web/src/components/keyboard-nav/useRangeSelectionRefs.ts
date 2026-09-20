// bdboard-sso1.39: BoardKeyboardNavProvider.tsx から、Shift+j/k 範囲選択の
// アンカー・直前範囲の記憶を move-only で切り出したフック。onContainerKeyDown
// (キー操作側) と getCardNavProps の onFocus (マウス操作側) の両方から使われる
// ため、両者の外側で共有できるようこの小さいフックへ分けている。
//
// resetRangeSelectionRefs は元の実装どおり useCallback で包まない（render の
// たびに新しい関数として再生成される）。参照する ref 自体は安定しており、
// この関数の恒等性が呼び出しのたびに変わっても、呼び出し側 (onContainerKeyDown
// 等) の依存配列には元々含まれていなかったため、挙動に影響しない。
import { useRef, type RefObject } from 'react';

export interface RangeSelectionRefs {
  readonly rangeAnchorRef: RefObject<string | null>;
  readonly lastRangeIdsRef: RefObject<readonly string[]>;
  readonly resetRangeSelectionRefs: () => void;
}

export function useRangeSelectionRefs(): RangeSelectionRefs {
  /** Shift+j/k 範囲選択のアンカー。通常の j/k 移動でリセットする */
  const rangeAnchorRef = useRef<string | null>(null);
  /** 直前の Shift+j/k で選択した範囲（行き過ぎ補正用） */
  const lastRangeIdsRef = useRef<readonly string[]>([]);

  const resetRangeSelectionRefs = () => {
    rangeAnchorRef.current = null;
    lastRangeIdsRef.current = [];
  };

  return { rangeAnchorRef, lastRangeIdsRef, resetRangeSelectionRefs };
}
