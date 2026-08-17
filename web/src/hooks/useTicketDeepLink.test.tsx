import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTicketDeepLink } from './useTicketDeepLink';

function renderDeepLink(
  initialView: 'merged' | 'stats' = 'merged',
  onViewChange = vi.fn(),
) {
  return renderHook(
    ({ view }) => useTicketDeepLink({ view, onViewChange }),
    { initialProps: { view: initialView } },
  );
}

describe('useTicketDeepLink', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens detail from initial hash (AC1)', () => {
    window.history.replaceState(null, '', '/#ticket=bdboard-1');

    const { result } = renderDeepLink();

    expect(result.current.selectedTicketId).toBe('bdboard-1');
  });

  it('applies view from initial hash without overwriting it (AC3)', async () => {
    window.history.replaceState(null, '', '/#view=stats');
    const onViewChange = vi.fn();

    renderDeepLink('merged', onViewChange);

    await waitFor(() => {
      expect(onViewChange).toHaveBeenCalledWith('stats');
    });
    expect(window.location.hash).toBe('#view=stats');
  });

  it('pushState on first selectTicket and sets hash', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const { result } = renderDeepLink();

    act(() => {
      result.current.selectTicket('a');
    });

    expect(pushSpy).toHaveBeenCalled();
    expect(window.location.hash).toBe('#ticket=a');
  });

  it('replaceState when switching tickets without pushing again', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const replaceSpy = vi.spyOn(window.history, 'replaceState');
    const { result } = renderDeepLink();

    act(() => {
      result.current.selectTicket('a');
    });

    const pushCountAfterFirst = pushSpy.mock.calls.length;

    act(() => {
      result.current.selectTicket('b');
    });

    expect(pushSpy.mock.calls.length).toBe(pushCountAfterFirst);
    expect(replaceSpy).toHaveBeenCalled();
    expect(window.location.hash).toBe('#ticket=b');
  });

  it('closeDetail calls history.back when detail was pushed (AC2)', () => {
    const backSpy = vi.spyOn(window.history, 'back');
    const { result } = renderDeepLink();

    act(() => {
      result.current.selectTicket('a');
    });

    act(() => {
      result.current.closeDetail();
    });

    expect(backSpy).toHaveBeenCalled();

    act(() => {
      window.history.replaceState(window.history.state, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.selectedTicketId).toBeNull();
  });

  it('closeDetail from direct hash load clears ticket and hash (AC2)', async () => {
    window.history.replaceState(null, '', '/#ticket=a');
    const { result } = renderDeepLink();

    act(() => {
      result.current.closeDetail();
    });

    expect(result.current.selectedTicketId).toBeNull();

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
  });

  it('keeps detail open when popstate leaves ticket in hash', () => {
    const { result } = renderDeepLink();

    act(() => {
      result.current.selectTicket('a');
    });

    expect(result.current.selectedTicketId).toBe('a');

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.selectedTicketId).toBe('a');
  });

  it('updates hash with view via replaceState when view changes (AC3)', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const replaceSpy = vi.spyOn(window.history, 'replaceState');
    const { result, rerender } = renderDeepLink();

    act(() => {
      result.current.selectTicket('a');
    });

    pushSpy.mockClear();
    replaceSpy.mockClear();

    rerender({ view: 'stats' });

    expect(pushSpy).not.toHaveBeenCalled();
    expect(replaceSpy).toHaveBeenCalled();
    expect(window.location.hash).toBe('#ticket=a&view=stats');
  });

  // useHistoryBackClose keeps its panel token in history.state; a hash sync that
  // replaces the state object would break the back gesture of ChatPanel /
  // SessionListPanel / SessionTailViewer. The sync has to actually run here
  // (closing the detail rewrites the URL), otherwise this asserts nothing.
  it('preserves existing history.state during hash sync', async () => {
    window.history.replaceState({ bdboardPanelToken: 'tok' }, '', '/#ticket=a');

    const { result } = renderDeepLink();

    act(() => {
      result.current.closeDetail();
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(
      (window.history.state as { bdboardPanelToken?: string } | null)
        ?.bdboardPanelToken,
    ).toBe('tok');
  });
});
