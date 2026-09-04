import { useLayoutEffect, useRef, type RefObject } from 'react';

// Viewport-relative gutter avoids hard-coded px that diverge across breakpoints.
const POPOVER_VIEWPORT_GUTTER_RATIO = 0.02;

function clampPopoverToViewport(el: HTMLElement): void {
  el.style.setProperty('--popover-shift-x', '0px');

  const rect = el.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const gutter = viewportWidth * POPOVER_VIEWPORT_GUTTER_RATIO;

  let shift = 0;
  if (rect.right > viewportWidth - gutter) {
    shift = viewportWidth - gutter - rect.right;
  }
  if (rect.left + shift < gutter) {
    shift = gutter - rect.left;
  }

  el.style.setProperty('--popover-shift-x', `${shift}px`);
}

/**
 * Horizontally shifts a popover via --popover-shift-x so it stays within the
 * viewport. Pair with `transform: translateX(var(--popover-shift-x, 0px))`.
 */
export function usePopoverViewportClamp<T extends HTMLElement>(
  open: boolean,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const el = ref.current;
    if (el === null) {
      return;
    }

    const recalculate = () => {
      clampPopoverToViewport(el);
    };

    recalculate();

    window.addEventListener('resize', recalculate);
    window.addEventListener('orientationchange', recalculate);

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(recalculate);
      resizeObserver.observe(el);
    }

    return () => {
      window.removeEventListener('resize', recalculate);
      window.removeEventListener('orientationchange', recalculate);
      resizeObserver?.disconnect();
      el.style.setProperty('--popover-shift-x', '0px');
    };
  }, [open]);

  return ref;
}
