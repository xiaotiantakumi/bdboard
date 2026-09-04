import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScrollHints } from './useScrollHints';

function ScrollHintsProbe() {
  const { ref, canScroll, canScrollStart, canScrollEnd } = useScrollHints<HTMLDivElement>();
  return (
    <div
      ref={ref}
      data-testid="scroll-container"
      data-can-scroll={String(canScroll)}
      data-can-scroll-start={String(canScrollStart)}
      data-can-scroll-end={String(canScrollEnd)}
    >
      <table>
        <tbody>
          <tr>
            <td>cell</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function mockScrollMetrics(
  el: HTMLElement,
  metrics: { scrollWidth: number; clientWidth: number; scrollLeft: number },
) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: metrics.scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: metrics.clientWidth });
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    value: metrics.scrollLeft,
    writable: true,
  });
}

describe('useScrollHints', () => {
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
  let resizeListener: (() => void) | undefined;
  let observedElements: Element[];

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    observedElements = [];
    resizeListener = undefined;
  });

  afterEach(() => {
    if (originalResizeObserver === undefined) {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    } else {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  function installFakeResizeObserver() {
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeListener = () => {
          callback([], this as unknown as ResizeObserver);
        };
      }
      observe = vi.fn((el: Element) => {
        observedElements.push(el);
      });
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  }

  it('observes the scroll container and its children with ResizeObserver', () => {
    installFakeResizeObserver();

    const { getByTestId } = render(<ScrollHintsProbe />);
    const container = getByTestId('scroll-container');
    const table = container.querySelector('table');
    expect(table).not.toBeNull();

    expect(observedElements).toContain(container);
    expect(observedElements).toContain(table);
  });

  it('registers and removes window resize fallback when ResizeObserver is unavailable', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    expect(typeof ResizeObserver).toBe('undefined');

    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { getByTestId, unmount } = render(<ScrollHintsProbe />);
    const container = getByTestId('scroll-container');

    expect(addSpy).toHaveBeenCalledWith('resize', expect.any(Function));

    mockScrollMetrics(container, { scrollWidth: 200, clientWidth: 200, scrollLeft: 0 });
    fireEvent(window, new Event('resize'));
    expect(container).toHaveAttribute('data-can-scroll', 'false');

    mockScrollMetrics(container, { scrollWidth: 300, clientWidth: 200, scrollLeft: 0 });
    fireEvent(window, new Event('resize'));
    expect(container).toHaveAttribute('data-can-scroll', 'true');
    expect(container).toHaveAttribute('data-can-scroll-end', 'true');

    unmount();
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('reports no overflow when content fits', () => {
    installFakeResizeObserver();

    const { getByTestId } = render(<ScrollHintsProbe />);
    const container = getByTestId('scroll-container');

    mockScrollMetrics(container, { scrollWidth: 200, clientWidth: 200, scrollLeft: 0 });
    fireEvent.scroll(container);

    expect(container).toHaveAttribute('data-can-scroll', 'false');
    expect(container).toHaveAttribute('data-can-scroll-start', 'false');
    expect(container).toHaveAttribute('data-can-scroll-end', 'false');
  });

  it('reports can-scroll-end at the left edge when overflowed', () => {
    installFakeResizeObserver();

    const { getByTestId } = render(<ScrollHintsProbe />);
    const container = getByTestId('scroll-container');

    mockScrollMetrics(container, { scrollWidth: 300, clientWidth: 200, scrollLeft: 0 });
    fireEvent.scroll(container);

    expect(container).toHaveAttribute('data-can-scroll', 'true');
    expect(container).toHaveAttribute('data-can-scroll-start', 'false');
    expect(container).toHaveAttribute('data-can-scroll-end', 'true');
  });

  it('reports can-scroll-start at the right edge when overflowed', () => {
    installFakeResizeObserver();

    const { getByTestId } = render(<ScrollHintsProbe />);
    const container = getByTestId('scroll-container');

    mockScrollMetrics(container, { scrollWidth: 300, clientWidth: 200, scrollLeft: 100 });
    fireEvent.scroll(container);

    expect(container).toHaveAttribute('data-can-scroll', 'true');
    expect(container).toHaveAttribute('data-can-scroll-start', 'true');
    expect(container).toHaveAttribute('data-can-scroll-end', 'false');
  });

  it('updates hints when ResizeObserver fires after inner content grows', () => {
    installFakeResizeObserver();

    const { getByTestId } = render(<ScrollHintsProbe />);
    const container = getByTestId('scroll-container');

    mockScrollMetrics(container, { scrollWidth: 200, clientWidth: 200, scrollLeft: 0 });
    expect(resizeListener).toBeDefined();
    act(() => {
      resizeListener?.();
    });
    expect(container).toHaveAttribute('data-can-scroll', 'false');

    mockScrollMetrics(container, { scrollWidth: 400, clientWidth: 200, scrollLeft: 0 });
    act(() => {
      resizeListener?.();
    });
    expect(container).toHaveAttribute('data-can-scroll', 'true');
    expect(container).toHaveAttribute('data-can-scroll-end', 'true');
  });
});
