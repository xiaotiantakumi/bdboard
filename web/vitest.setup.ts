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
