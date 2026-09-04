import { useLayoutEffect, type RefObject } from 'react';

const CSS_VAR = '--lane-strip-height';

/**
 * Writes the lane indicator strip height to documentElement as --lane-strip-height
 * (ResizeObserver when available, otherwise window resize). Combined with
 * --header-height on html scroll-padding-top so keyboard scrollIntoView clears
 * the sticky strip below the header on mobile.
 */
export function useLaneStripHeightVar(
  ref: RefObject<HTMLElement | null>,
  active = true,
): void {
  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const element = active ? ref.current : null;
    if (element === null) {
      document.documentElement.style.removeProperty(CSS_VAR);
      return;
    }

    const syncStripHeight = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      document.documentElement.style.setProperty(CSS_VAR, `${height}px`);
    };

    syncStripHeight();

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(syncStripHeight);
      resizeObserver.observe(element);
    }
    window.addEventListener('resize', syncStripHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', syncStripHeight);
      document.documentElement.style.removeProperty(CSS_VAR);
    };
  }, [ref, active]);
}
