import { useLayoutEffect } from 'react';

/**
 * Writes .header height to documentElement as --header-height (ResizeObserver).
 * Drives sticky lane strip `top` and html scroll-padding-top for keyboard focus.
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
    const resizeObserver = new ResizeObserver(syncHeaderHeight);
    resizeObserver.observe(header);
    window.addEventListener('resize', syncHeaderHeight);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', syncHeaderHeight);
      document.documentElement.style.removeProperty('--header-height');
    };
  }, []);
}
