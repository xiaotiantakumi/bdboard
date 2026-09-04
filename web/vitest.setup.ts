import '@testing-library/jest-dom/vitest';

// jsdom does not implement matchMedia. Production layout code (useResizableSidePanel,
// useMatchMedia, BoardView lane indicator) reads the same breakpoint as CSS
// @media (max-width: 700px). Evaluating against documentElement.clientWidth (with
// innerWidth fallback when clientWidth is 0) keeps JS aligned with CSS media queries
// and lets unit tests inject overflow (inflated innerWidth + narrow clientWidth).
//
// NOTE (bdboard-vn1x): there is deliberately NO ResizeObserver stub here. A no-op stub
// used to live alongside this one, and it silently made the window-resize fallback in
// GlobalBar / useHeaderHeightVar unreachable from unit tests. Both call sites now guard
// with `typeof ResizeObserver !== 'undefined'`, so jsdom exercises the fallback for real.
// Do not reintroduce a stub: web/src/hooks/useHeaderHeightVar.test.tsx and
// web/src/components/GlobalBar.test.tsx assert `typeof ResizeObserver === 'undefined'`
// and will fail loudly if one comes back.
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
