import { useLayoutEffect, useState } from 'react';

// Viewport-relative gutter avoids hard-coded px that diverge across breakpoints.
const POPOVER_VIEWPORT_GUTTER_RATIO = 0.02;
// Ratio-only gutters shrink on narrow viewports (320px→6.4px) where margin matters most;
// align with repo conventions (.undo-snackbar uses calc(100vw - 32px), etc.).
const POPOVER_VIEWPORT_GUTTER_MIN_PX = 12;

function clampPopoverToViewport(el: HTMLElement): void {
  el.style.setProperty('--popover-shift-x', '0px');

  const rect = el.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const gutter = Math.max(
    POPOVER_VIEWPORT_GUTTER_MIN_PX,
    viewportWidth * POPOVER_VIEWPORT_GUTTER_RATIO,
  );

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
 *
 * Returns a callback ref (not RefObject) so layout effect re-runs when the DOM
 * node is replaced while `open` stays true — e.g. AiQuotaWidget keeps
 * popoverOpen but unmounts the popover on fetch error and remounts on recovery.
 */
export function usePopoverViewportClamp<T extends HTMLElement>(
  open: boolean,
): (element: T | null) => void {
  const [element, setElement] = useState<T | null>(null);

  useLayoutEffect(() => {
    if (!open || element === null) {
      return;
    }

    const recalculate = () => {
      clampPopoverToViewport(element);
    };

    recalculate();

    window.addEventListener('resize', recalculate);
    window.addEventListener('orientationchange', recalculate);

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(recalculate);
      resizeObserver.observe(element);
    }

    return () => {
      window.removeEventListener('resize', recalculate);
      window.removeEventListener('orientationchange', recalculate);
      resizeObserver?.disconnect();
      element.style.setProperty('--popover-shift-x', '0px');
    };
  }, [open, element]);

  return setElement;
}
