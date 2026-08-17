import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
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
