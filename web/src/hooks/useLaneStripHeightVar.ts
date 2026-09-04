import { useLayoutEffect, type RefObject } from 'react';

const CSS_VAR = '--lane-strip-height';

const registry = new Set<HTMLElement>();

function syncFromRegistry(): void {
  if (registry.size === 0) {
    document.documentElement.style.removeProperty(CSS_VAR);
    return;
  }
  let max = 0;
  for (const el of registry) {
    max = Math.max(max, Math.ceil(el.getBoundingClientRect().height));
  }
  document.documentElement.style.setProperty(CSS_VAR, `${max}px`);
}

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
      syncFromRegistry();
      return;
    }

    registry.add(element);
    syncFromRegistry();

    // Per-effect closure, not the shared syncFromRegistry reference: addEventListener
    // de-duplicates identical (type, listener, capture) triples, so N mounted strips would
    // register only one listener and the first unmount would remove it for all of them.
    const handleWindowResize = (): void => {
      syncFromRegistry();
    };

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(handleWindowResize);
      resizeObserver.observe(element, { box: 'border-box' });
    }
    window.addEventListener('resize', handleWindowResize);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      registry.delete(element);
      syncFromRegistry();
    };
  }, [ref, active]);
}
