import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

function FocusTrapFixture({
  enabled = true,
  useInitialFocusRef = true,
  onEscape,
}: {
  enabled?: boolean;
  useInitialFocusRef?: boolean;
  onEscape?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  useFocusTrap({
    containerRef,
    initialFocusRef: useInitialFocusRef ? initialFocusRef : undefined,
    enabled,
    onEscape,
  });

  return (
    <div>
      <button type="button">Outside</button>
      <div ref={containerRef} tabIndex={-1} data-testid="trap-container">
        <button type="button">First</button>
        <button ref={initialFocusRef} type="button">
          Initial
        </button>
        <button type="button">Last</button>
      </div>
    </div>
  );
}

describe('useFocusTrap', () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('focuses initialFocusRef synchronously even when rAF never fires', () => {
    render(<FocusTrapFixture />);

    expect(screen.getByRole('button', { name: 'Initial' })).toHaveFocus();
    expect(rafCallbacks).toHaveLength(0);
  });

  it('focuses the first focusable element when initialFocusRef is omitted', () => {
    render(<FocusTrapFixture useInitialFocusRef={false} />);

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    expect(rafCallbacks).toHaveLength(0);
  });

  it('calls onEscape when rAF never fires', () => {
    const onEscape = vi.fn();
    render(<FocusTrapFixture onEscape={onEscape} />);

    expect(screen.getByRole('button', { name: 'Initial' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(rafCallbacks).toHaveLength(0);
  });

  it('restores focus to the element that was active before enabling the trap', () => {
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Previous';
    document.body.appendChild(outside);
    outside.focus();

    const { unmount } = render(<FocusTrapFixture />);

    expect(screen.getByRole('button', { name: 'Initial' })).toHaveFocus();

    unmount();

    expect(outside).toHaveFocus();
    outside.remove();
  });
});
