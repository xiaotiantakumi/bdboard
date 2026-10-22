import { useEffect, useRef, type RefObject } from 'react';

/**
 * ヘッダーの入れ子ポップオーバー (フィルタ / ⋯ メニュー) 用の閉じ処理。
 * useExclusivePopover と違って Coordinator に登録しない: 中に入れたプリセットや
 * AIクォータのポップオーバーが開いたときに、親まで閉じられてしまうのを避けるため。
 * 外側クリックと Esc だけで閉じる。返り値の ref はボタンとポップオーバーを含む要素に付ける。
 */
export function useMenuDismiss(
  open: boolean,
  onClose: () => void,
): RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        containerRef.current !== null &&
        !containerRef.current.contains(target)
      ) {
        onCloseRef.current();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      const active = document.activeElement;
      const focusIsElsewhere =
        active !== null &&
        active !== document.body &&
        containerRef.current !== null &&
        !containerRef.current.contains(active);
      if (focusIsElsewhere) {
        return;
      }
      onCloseRef.current();
      if (active !== null && active !== document.body) {
        containerRef.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return containerRef;
}
