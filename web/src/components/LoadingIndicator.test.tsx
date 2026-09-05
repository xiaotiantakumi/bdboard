import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadingIndicator } from './LoadingIndicator';

describe('LoadingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows only the label immediately without elapsed seconds', () => {
    render(<LoadingIndicator />);

    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
    expect(screen.queryByText(/\(\d+秒経過\)/)).toBeNull();
  });

  it('shows elapsed seconds after the threshold is exceeded', () => {
    render(<LoadingIndicator showElapsedAfterMs={2000} />);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByText('(3秒経過)')).toBeInTheDocument();
  });

  it('does not show elapsed seconds just below the threshold', () => {
    render(<LoadingIndicator showElapsedAfterMs={2000} />);

    act(() => {
      vi.advanceTimersByTime(1999);
    });

    expect(screen.queryByText(/\(\d+秒経過\)/)).toBeNull();
  });

  it('keeps getByText("読み込み中…") matching after elapsed seconds appear', () => {
    render(<LoadingIndicator showElapsedAfterMs={2000} />);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
    expect(screen.getByText('(3秒経過)')).toBeInTheDocument();
  });

  it('clears the interval on unmount', () => {
    const { unmount } = render(<LoadingIndicator showElapsedAfterMs={2000} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
