import '@testing-library/jest-dom/vitest';

// jsdom does not implement ResizeObserver. Production code (e.g. useHeaderHeightVar)
// relies on it unconditionally because real browsers always provide it.
//
// A no-op stub is sufficient here: jsdom never performs layout, so element sizes do
// not change and getBoundingClientRect() always returns zeros. ResizeObserver
// callbacks would never fire meaningfully anyway. Header height behavior is covered
// by e2e tests (test/e2e/header-sticky.spec.ts, test/e2e/kanban-mobile-lanes.spec.ts).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// jsdom does not implement matchMedia. Production layout code (useResizableSidePanel,
// useMatchMedia, BoardView lane indicator) reads the same breakpoint as CSS
// @media (max-width: 700px). Evaluating against documentElement.clientWidth (with
// innerWidth fallback when clientWidth is 0) keeps JS aligned with CSS media queries
// and lets unit tests inject overflow (inflated innerWidth + narrow clientWidth).
if (typeof globalThis.matchMedia === 'undefined') {
  globalThis.matchMedia = (query: string): MediaQueryList => {
    const parseMaxWidthPx = (mediaQuery: string): number | null => {
      const match = mediaQuery.match(/^\(max-width:\s*(\d+(?:\.\d+)?)px\)$/);
      return match ? Number(match[1]) : null;
    };

    const layoutViewportWidth = (): number => {
      const clientWidth = document.documentElement.clientWidth;
      return clientWidth || window.innerWidth;
    };

    const evaluateMatches = (): boolean => {
      const maxWidth = parseMaxWidthPx(query);
      if (maxWidth === null) return false;
      return layoutViewportWidth() <= maxWidth;
    };

    return {
      media: query,
      get matches() {
        return evaluateMatches();
      },
      onchange: null,
      addEventListener(): void {},
      removeEventListener(): void {},
      // lib.dom still requires these deprecated members on MediaQueryList.
      addListener(): void {},
      removeListener(): void {},
      dispatchEvent(): boolean {
        return true;
      },
    };
  };
}
