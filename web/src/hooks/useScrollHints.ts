import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Tracks horizontal scroll overflow hints for a scroll container (can-scroll-start /
 * can-scroll-end). Logic matches GlobalBar's updateScrollHints; GlobalBar is not
 * migrated to this hook in bdboard-83tc to avoid churn in existing tests.
 */
export function useScrollHints<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  canScroll: boolean;
  canScrollStart: boolean;
  canScrollEnd: boolean;
} {
  const ref = useRef<T | null>(null);
  const [canScroll, setCanScroll] = useState(false);
  const [canScrollStart, setCanScrollStart] = useState(false);
  const [canScrollEnd, setCanScrollEnd] = useState(false);

  const updateScrollHints = useCallback(() => {
    const el = ref.current;
    if (el === null) {
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const overflow = scrollWidth - clientWidth;
    if (overflow <= 1) {
      setCanScroll(false);
      setCanScrollStart(false);
      setCanScrollEnd(false);
      return;
    }
    setCanScroll(true);
    setCanScrollStart(scrollLeft > 1);
    setCanScrollEnd(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el === null) {
      return;
    }

    updateScrollHints();

    el.addEventListener('scroll', updateScrollHints, { passive: true });

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(updateScrollHints);
      resizeObserver.observe(el);
      // The container box may stay fixed while inner content (e.g. <table>) grows wider;
      // observing only the container misses scrollWidth changes and stale fade hints.
      for (const child of Array.from(el.children)) {
        resizeObserver.observe(child);
      }
    } else {
      window.addEventListener('resize', updateScrollHints);
    }

    return () => {
      el.removeEventListener('scroll', updateScrollHints);
      resizeObserver?.disconnect();
      if (resizeObserver === undefined) {
        window.removeEventListener('resize', updateScrollHints);
      }
    };
  }, [updateScrollHints]);

  return { ref, canScroll, canScrollStart, canScrollEnd };
}
