import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHeaderHeightVar } from './useHeaderHeightVar';

function HeaderHeightProbe() {
  useHeaderHeightVar();
  return (
    <header className="header" data-testid="header">
      header
    </header>
  );
}

function stubHeaderHeight(height: number) {
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: 0,
    height,
    top: 0,
    right: 0,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  });
}

describe('useHeaderHeightVar', () => {
  let rectSpy: ReturnType<typeof stubHeaderHeight> | undefined;
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

  beforeEach(() => {
    document.documentElement.style.removeProperty('--header-height');
    originalResizeObserver = globalThis.ResizeObserver;
  });

  afterEach(() => {
    rectSpy?.mockRestore();
    rectSpy = undefined;
    document.documentElement.style.removeProperty('--header-height');
    if (originalResizeObserver === undefined) {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    } else {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('sets --header-height on mount and updates on window resize when ResizeObserver is unavailable', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    expect(typeof ResizeObserver).toBe('undefined');

    rectSpy = stubHeaderHeight(72);
    render(<HeaderHeightProbe />);

    expect(document.documentElement.style.getPropertyValue('--header-height')).toBe('72px');

    rectSpy.mockReturnValue({
      x: 0,
      y: 0,
      width: 0,
      height: 96,
      top: 0,
      right: 0,
      bottom: 96,
      left: 0,
      toJSON: () => ({}),
    });
    fireEvent(window, new Event('resize'));

    expect(document.documentElement.style.getPropertyValue('--header-height')).toBe('96px');
  });

  it('removes --header-height and resize listener on unmount', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;

    rectSpy = stubHeaderHeight(80);
    const { unmount } = render(<HeaderHeightProbe />);
    expect(document.documentElement.style.getPropertyValue('--header-height')).toBe('80px');

    unmount();
    expect(document.documentElement.style.getPropertyValue('--header-height')).toBe('');

    rectSpy.mockReturnValue({
      x: 0,
      y: 0,
      width: 0,
      height: 120,
      top: 0,
      right: 0,
      bottom: 120,
      left: 0,
      toJSON: () => ({}),
    });
    expect(() => {
      fireEvent(window, new Event('resize'));
    }).not.toThrow();
    expect(document.documentElement.style.getPropertyValue('--header-height')).toBe('');
  });

  it('observes the header with ResizeObserver when available', () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    class FakeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

    rectSpy = stubHeaderHeight(64);
    const { unmount } = render(<HeaderHeightProbe />);
    const header = document.querySelector('.header');
    expect(header).not.toBeNull();
    expect(observe).toHaveBeenCalledWith(header);

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
