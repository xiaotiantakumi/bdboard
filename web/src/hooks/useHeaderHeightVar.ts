import { useLayoutEffect } from 'react';

/**
 * Writes .header height to documentElement as --header-height (ResizeObserver when
 * available, otherwise window resize). Drives sticky lane strip `top`; header portion
 * of html scroll-padding-top (strip height is useLaneStripHeightVar).
 */
export function useHeaderHeightVar(): void {
  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const header = document.querySelector<HTMLElement>('.header');
    if (header === null) {
      return;
    }
    const syncHeaderHeight = () => {
      const height = Math.ceil(header.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--header-height', `${height}px`);
    };
    syncHeaderHeight();
    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(syncHeaderHeight);
      resizeObserver.observe(header);
    }
    window.addEventListener('resize', syncHeaderHeight);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', syncHeaderHeight);
      document.documentElement.style.removeProperty('--header-height');
    };
  }, []);
}
