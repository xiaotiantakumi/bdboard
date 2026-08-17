import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppBadge } from './useAppBadge';

const updateAppBadge = vi.fn();

vi.mock('../appBadge', () => ({
  updateAppBadge: (...args: unknown[]) => updateAppBadge(...args),
}));

describe('useAppBadge', () => {
  beforeEach(() => {
    updateAppBadge.mockClear();
  });

  it('calls updateAppBadge with zero when count is undefined', () => {
    renderHook(() => useAppBadge(undefined));

    expect(updateAppBadge).toHaveBeenCalledWith(0);
  });

  it('calls updateAppBadge when count changes', () => {
    const { rerender } = renderHook(({ count }) => useAppBadge(count), {
      initialProps: { count: 2 as number | undefined },
    });

    expect(updateAppBadge).toHaveBeenCalledWith(2);

    rerender({ count: 5 });
    expect(updateAppBadge).toHaveBeenCalledWith(5);

    rerender({ count: 0 });
    expect(updateAppBadge).toHaveBeenCalledWith(0);
  });
});
