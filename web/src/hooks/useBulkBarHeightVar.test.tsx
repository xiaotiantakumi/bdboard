import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useBulkBarHeightVar } from './useBulkBarHeightVar';

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

function BulkBarProbe({ active = true }: { active?: boolean }) {
  const barRef = useRef<HTMLDivElement>(null);
  useBulkBarHeightVar(barRef, active);
  if (!active) {
    return null;
  }
  return (
    <div ref={barRef} className="bulk-action-bar" data-testid="bar">
      bar
    </div>
  );
}

describe('useBulkBarHeightVar', () => {
  let rectSpy: ReturnType<typeof stubElementHeight> | undefined;
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

  beforeEach(() => {
    document.documentElement.style.removeProperty('--bulk-bar-height');
    originalResizeObserver = globalThis.ResizeObserver;
  });

  afterEach(() => {
    rectSpy?.mockRestore();
    rectSpy = undefined;
    document.documentElement.style.removeProperty('--bulk-bar-height');
    if (originalResizeObserver === undefined) {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    } else {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('sets --bulk-bar-height on mount and updates on window resize when ResizeObserver is unavailable', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    expect(typeof ResizeObserver).toBe('undefined');

    rectSpy = stubElementHeight(178);
    render(<BulkBarProbe />);

    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('178px');

    rectSpy.mockReturnValue({
      x: 0,
      y: 0,
      width: 0,
      height: 220.25,
      top: 0,
      right: 0,
      bottom: 220.25,
      left: 0,
      toJSON: () => ({}),
    });
    fireEvent(window, new Event('resize'));

    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('221px');
  });

  it('removes --bulk-bar-height and resize listener on unmount', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;

    rectSpy = stubElementHeight(178);
    const { unmount } = render(<BulkBarProbe />);
    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('178px');

    unmount();
    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('');

    rectSpy.mockReturnValue({
      x: 0,
      y: 0,
      width: 0,
      height: 240,
      top: 0,
      right: 0,
      bottom: 240,
      left: 0,
      toJSON: () => ({}),
    });
    expect(() => {
      fireEvent(window, new Event('resize'));
    }).not.toThrow();
    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('');
  });

  it('observes the bar with ResizeObserver when available', () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    class FakeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

    rectSpy = stubElementHeight(178);
    const { unmount } = render(<BulkBarProbe />);
    const bar = document.querySelector('.bulk-action-bar');
    expect(bar).not.toBeNull();
    expect(observe).toHaveBeenCalledWith(bar, { box: 'border-box' });

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('uses the maximum height and keeps the variable when one of multiple bars unmounts', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element) {
        const height = this.getAttribute('data-testid') === 'tall-bar' ? 220 : 178;
        return {
          x: 0,
          y: 0,
          width: 0,
          height,
          top: 0,
          right: 0,
          bottom: height,
          left: 0,
          toJSON: () => ({}),
        };
      });

    function NamedBulkBarProbe({ testId }: { testId: string }) {
      const barRef = useRef<HTMLDivElement>(null);
      useBulkBarHeightVar(barRef);
      return <div ref={barRef} className="bulk-action-bar" data-testid={testId} />;
    }

    const first = render(<NamedBulkBarProbe testId="short-bar" />);
    const second = render(<NamedBulkBarProbe testId="tall-bar" />);
    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('220px');

    second.unmount();

    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('178px');

    first.unmount();
    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('');
  });

  it('keeps updating on window resize after a sibling bar unmounts', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    rectSpy = stubElementHeight(178);

    const first = render(<BulkBarProbe />);
    const second = render(<BulkBarProbe />);
    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('178px');

    second.unmount();
    expect(document.querySelectorAll('.bulk-action-bar').length).toBe(1);

    // The surviving bar must still track window resizes: addEventListener de-duplicates
    // identical listener references, so a shared module-level handler would have been
    // removed for everyone by the unmount above.
    rectSpy.mockReturnValue({
      x: 0,
      y: 0,
      width: 0,
      height: 240,
      top: 0,
      right: 0,
      bottom: 240,
      left: 0,
      toJSON: () => ({}),
    });
    fireEvent(window, new Event('resize'));

    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('240px');

    first.unmount();
    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('');
  });

  it('clears --bulk-bar-height when active is false', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;

    rectSpy = stubElementHeight(178);
    const { rerender } = render(<BulkBarProbe active />);
    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('178px');

    rerender(<BulkBarProbe active={false} />);
    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('');
  });

  it('sets --bulk-bar-height when active becomes true', () => {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;

    rectSpy = stubElementHeight(178);
    const { rerender } = render(<BulkBarProbe active={false} />);
    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('');

    rerender(<BulkBarProbe active />);
    expect(document.documentElement.style.getPropertyValue('--bulk-bar-height')).toBe('178px');
  });
});
