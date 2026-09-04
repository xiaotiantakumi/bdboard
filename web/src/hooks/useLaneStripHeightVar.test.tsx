import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useLaneStripHeightVar } from './useLaneStripHeightVar';

function stubElementHeight(height: number) {
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

function LaneStripProbe({ active = true }: { active?: boolean }) {
  const stripRef = useRef<HTMLElement>(null);
  useLaneStripHeightVar(stripRef, active);
  if (!active) {
    return null;
  }
  return (
    <nav ref={stripRef} className="lane-indicator-strip" data-testid="strip">
      strip
    </nav>
  );
}

describe('useLaneStripHeightVar', () => {
  let rectSpy: ReturnType<typeof stubElementHeight> | undefined;
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

  beforeEach(() => {
    document.documentElement.style.removeProperty('--lane-strip-height');
    originalResizeObserver = globalThis.ResizeObserver;
  });

  afterEach(() => {
    rectSpy?.mockRestore();
    rectSpy = undefined;
    document.documentElement.style.removeProperty('--lane-strip-height');
    if (originalResizeObserver === undefined) {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    } else {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('sets --lane-strip-height on mount and updates on window resize when ResizeObserver is unavailable', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    expect(typeof ResizeObserver).toBe('undefined');

    rectSpy = stubElementHeight(48);
    render(<LaneStripProbe />);

    expect(document.documentElement.style.getPropertyValue('--lane-strip-height')).toBe('48px');

    rectSpy.mockReturnValue({
      x: 0,
      y: 0,
      width: 0,
      height: 56,
      top: 0,
      right: 0,
      bottom: 56,
      left: 0,
      toJSON: () => ({}),
    });
    fireEvent(window, new Event('resize'));

    expect(document.documentElement.style.getPropertyValue('--lane-strip-height')).toBe('56px');
  });

  it('removes --lane-strip-height and resize listener on unmount', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;

    rectSpy = stubElementHeight(40);
    const { unmount } = render(<LaneStripProbe />);
    expect(document.documentElement.style.getPropertyValue('--lane-strip-height')).toBe('40px');

    unmount();
    expect(document.documentElement.style.getPropertyValue('--lane-strip-height')).toBe('');

    rectSpy.mockReturnValue({
      x: 0,
      y: 0,
      width: 0,
      height: 72,
      top: 0,
      right: 0,
      bottom: 72,
      left: 0,
      toJSON: () => ({}),
    });
    expect(() => {
      fireEvent(window, new Event('resize'));
    }).not.toThrow();
    expect(document.documentElement.style.getPropertyValue('--lane-strip-height')).toBe('');
  });

  it('observes the strip with ResizeObserver when available', () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    class FakeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

    rectSpy = stubElementHeight(32);
    const { unmount } = render(<LaneStripProbe />);
    const strip = document.querySelector('.lane-indicator-strip');
    expect(strip).not.toBeNull();
    expect(observe).toHaveBeenCalledWith(strip);

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('clears --lane-strip-height when active is false', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;

    rectSpy = stubElementHeight(44);
    const { rerender } = render(<LaneStripProbe active />);
    expect(document.documentElement.style.getPropertyValue('--lane-strip-height')).toBe('44px');

    rerender(<LaneStripProbe active={false} />);
    expect(document.documentElement.style.getPropertyValue('--lane-strip-height')).toBe('');
  });
});
