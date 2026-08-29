import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * CSS で見えていない要素を Tab 巡回から外すための判定(bdboard-77k)。
 *
 * セレクタは `disabled` と `tabindex="-1"` しか見ないので、CSS で消しただけの
 * ボタンが巡回対象に残る。実例はチャットパネルの「最大化」で、幅 700px 以下では
 * 表示していないのに Tab では止まってしまう。
 *
 * 祖先まで遡るのは `display: none` の子孫で `getComputedStyle` しても 'none' が
 * 返らない(その要素自身の指定値が返る)ため。`visibility` は継承するので本来は
 * 自分だけ見れば足りるが、同じループで拾えるのでまとめて判定している。
 *
 * `hidden` 属性は個別に見ていない。ブラウザも jsdom も UA スタイルシートの
 * `[hidden] { display: none }` として扱うので computed style 側で拾える。
 * 属性の有無を直接見ると、著者スタイルで打ち消して見せている要素まで
 * 巡回から外してしまい、かえって仕様から外れる。
 */
function isVisible(element: HTMLElement): boolean {
  for (
    let current: HTMLElement | null = element;
    current !== null;
    current = current.parentElement
  ) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
  }
  return true;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isVisible,
  );
}

export interface UseFocusTrapOptions {
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  enabled?: boolean;
  onEscape?: () => void;
}

/**
 * ダイアログ内の初期フォーカス・Tab 循環・Escape・閉じたあとのフォーカス復帰。
 * ハンドラは container 要素にのみ付与し、document 全体とは競合しない。
 */
export function useFocusTrap({
  containerRef,
  initialFocusRef,
  enabled = true,
  onEscape,
}: UseFocusTrapOptions): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const previous = document.activeElement;
    previousFocusRef.current = previous instanceof HTMLElement ? previous : null;

    const container = containerRef.current;

    const focusInitial = () => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
        return;
      }
      if (container === null) {
        return;
      }
      const focusable = getFocusableElements(container);
      focusable[0]?.focus();
    };

    // バックグラウンドタブでは requestAnimationFrame が間引かれるため、
    // 同期で初期フォーカスを当て、コンテナ内に入らなければ rAF をフォールバックにする。
    focusInitial();

    let rafId: number | undefined;
    if (container === null || !container.contains(document.activeElement)) {
      rafId = requestAnimationFrame(focusInitial);
    }

    if (container === null) {
      return () => {
        if (rafId !== undefined) {
          cancelAnimationFrame(rafId);
        }
        const el = previousFocusRef.current;
        if (el !== null && document.contains(el)) {
          el.focus();
        }
      };
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onEscapeRef.current !== undefined) {
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        onEscapeRef.current();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);

    return () => {
      if (rafId !== undefined) {
        cancelAnimationFrame(rafId);
      }
      container.removeEventListener('keydown', onKeyDown);
      const el = previousFocusRef.current;
      if (el !== null && document.contains(el)) {
        el.focus();
      }
    };
  }, [enabled, containerRef, initialFocusRef]);
}
