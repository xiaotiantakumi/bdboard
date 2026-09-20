// bdboard-sso1.39: BoardKeyboardNavProvider.tsx の onContainerKeyDown から、
// 「このキーイベントを無視するか」「どちらの方向のキーか」の純判定を
// move-only で切り出したファイル。イベントを読むだけで、preventDefault
// などの副作用は呼び出し側 (onContainerKeyDown) に残す。
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * onContainerKeyDown の先頭ガード（対象外イベント判定）。
 * defaultPrevented / 修飾キー / フォーム要素・contentEditable 上での
 * キー入力を無視する。
 */
export function shouldIgnoreContainerKeydown(
  event: ReactKeyboardEvent<HTMLElement>,
): boolean {
  if (event.defaultPrevented) {
    return true;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return true;
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
      return true;
    }
  }
  return false;
}

/** レーン内で「次」方向を表すキーか（ArrowDown / j） */
export function isNextInLaneKey(key: string): boolean {
  return key === 'ArrowDown' || key === 'j';
}

/** レーン内で「前」方向を表すキーか（ArrowUp / k） */
export function isPrevInLaneKey(key: string): boolean {
  return key === 'ArrowUp' || key === 'k';
}
