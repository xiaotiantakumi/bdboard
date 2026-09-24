import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useElapsedSeconds } from './useElapsedSeconds';

function Probe() {
  const [active, setActive] = useState(false);
  const seconds = useElapsedSeconds(active);
  return (
    <div>
      <output>{seconds}</output>
      <button type="button" onClick={() => setActive((value) => !value)}>toggle</button>
    </div>
  );
}

describe('useElapsedSeconds', () => {
  afterEach(() => vi.useRealTimers());

  it('counts from zero while active, resets immediately, and clears its interval on unmount', () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = render(<Probe />);
    const seconds = () => screen.getByRole('status').textContent;

    expect(seconds()).toBe('0');
    act(() => screen.getByRole('button').click());
    expect(seconds()).toBe('0');
    act(() => vi.advanceTimersByTime(2_000));
    expect(seconds()).toBe('2');
    act(() => screen.getByRole('button').click());
    expect(seconds()).toBe('0');
    expect(vi.getTimerCount()).toBe(0);

    act(() => screen.getByRole('button').click());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
