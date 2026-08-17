import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryBackClose } from './useHistoryBackClose';
import { installFakeHistory, type FakeHistory } from '../test/fakeHistory';

describe('useHistoryBackClose', () => {
  let fakeHistory: FakeHistory;

  beforeEach(() => {
    fakeHistory = installFakeHistory({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pushes one history entry when enabled and does not push again on rerender', () => {
    const onClose = vi.fn();

    const { rerender } = renderHook(
      ({ enabled }) =>
        useHistoryBackClose({
          panelId: 'ticket-detail',
          onClose,
          enabled,
        }),
      { initialProps: { enabled: true } },
    );

    expect(fakeHistory.pushState).toHaveBeenCalledTimes(1);
    expect(fakeHistory.pushState.mock.calls[0]?.[0]).toMatchObject({
      bdboardPanel: 'ticket-detail',
      bdboardPanelToken: expect.any(String),
    });

    rerender({ enabled: true });
    expect(fakeHistory.pushState).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when popstate consumes the pushed entry', () => {
    const onClose = vi.fn();

    renderHook(() =>
      useHistoryBackClose({
        panelId: 'ticket-detail',
        onClose,
        enabled: true,
      }),
    );

    const pushedToken = (
      fakeHistory.pushState.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined
    )?.bdboardPanelToken;
    expect(typeof pushedToken).toBe('string');

    act(() => {
      fakeHistory.back();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fakeHistory.getCurrentState()).not.toMatchObject({
      bdboardPanelToken: pushedToken,
    });
  });

  it('requestClose calls onClose and consumes the pushed entry via history.back', () => {
    const onClose = vi.fn();

    const { result } = renderHook(() =>
      useHistoryBackClose({
        panelId: 'ticket-detail',
        onClose,
        enabled: true,
      }),
    );

    act(() => {
      result.current.requestClose();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fakeHistory.back).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose twice when requestClose triggers popstate', () => {
    const onClose = vi.fn();

    const { result } = renderHook(() =>
      useHistoryBackClose({
        panelId: 'ticket-detail',
        onClose,
        enabled: true,
      }),
    );

    act(() => {
      result.current.requestClose();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
