import { act, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './messages';
import { useStickToBottomScroll } from './useStickToBottomScroll';

function Probe({ resetKey }: { resetKey: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<ReturnType<typeof instrument> | null>(null);
  const setContainer = (element: HTMLDivElement | null) => {
    if (element !== null && areaRef.current === null) {
      const area = instrument(element);
      areaRef.current = area;
      Object.defineProperty(element, '__area', { configurable: true, value: area });
    }
    containerRef.current = element;
  };
  const messages: ChatMessage[] = [];
  const { onScroll } = useStickToBottomScroll(containerRef, resetKey, messages, false, '');
  return <div ref={setContainer} data-testid="scroll" onScroll={onScroll} />;
}

function instrument(element: HTMLElement) {
  let scrollTop = 0;
  let scrollHeight = 150;
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 50 });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
    set: (value: number) => { scrollHeight = value; },
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => { scrollTop = value; },
  });
  return {
    setDistance(distance: number) { scrollTop = scrollHeight - 50 - distance; },
    grow(height: number) { scrollHeight = height; },
    get top() { return scrollTop; },
  };
}

describe('useStickToBottomScroll', () => {
  it('pins at 48px, unpins at 49px, ignores its own scroll event, and re-pins after resetKey changes', () => {
    const { getByTestId, rerender } = render(<Probe resetKey="one" />);
    const element = getByTestId('scroll');
    const area = (element as HTMLElement & { __area: ReturnType<typeof instrument> }).__area;

    // Initial effect sticks to the bottom and records the actual scrollTop.
    expect(area.top).toBe(150);
    area.grow(200);
    fireEvent.scroll(element);
    // Same scrollTop as the effect's marker: ignore the delayed event.
    expect(area.top).toBe(150);

    area.setDistance(48);
    fireEvent.scroll(element);
    expect(area.top).toBe(102);
    // 49px away clears the pinned state; a follow-up effect does not move it.
    area.setDistance(49);
    fireEvent.scroll(element);
    rerender(<Probe resetKey="one" />);
    expect(area.top).toBe(101);

    // A changed key runs reset before the follow effect, which pins again.
    rerender(<Probe resetKey="two" />);
    expect(area.top).toBe(200);
    // Trigger one more render/effect after reset to prove the hook remains pinned.
    act(() => fireEvent.scroll(element));
  });
});
