import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
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

  it('calls history.back on a genuine unmount without requestClose (deferred to a microtask)', async () => {
    const onClose = vi.fn();

    const { unmount } = renderHook(() =>
      useHistoryBackClose({
        panelId: 'ticket-detail',
        onClose,
        enabled: true,
      }),
    );

    unmount();

    // 本来の(StrictModeを介さない)アンマウントでは、history.back() は
    // マイクロタスク経由で呼ばれる。
    expect(fakeHistory.back).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fakeHistory.back).toHaveBeenCalledTimes(1);
  });

  it('does not flash-close under StrictMode double-invoked effects (bdboard-ge1 regression)', async () => {
    const onClose = vi.fn();

    renderHook(
      () =>
        useHistoryBackClose({
          panelId: 'sessions',
          onClose,
          enabled: true,
        }),
      { wrapper: StrictMode },
    );

    // StrictMode の「マウント→クリーンアップ→再マウント」二重実行が同期的に
    // 走った直後の状態。ここでは history.back() 呼び出しがまだマイクロタスク
    // 待ちのはずで、この時点でonCloseが呼ばれていてはならない。
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
    });

    // マイクロタスクが流れた後も、二重実行の2回目のマウントで pushedRef が
    // 再度trueになっているため、余分な history.back() は呼ばれず、
    // したがってpopstateも発火せず、パネルが誤って閉じられることは無い。
    expect(fakeHistory.back).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
