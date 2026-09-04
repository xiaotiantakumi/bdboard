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

  // installFakeHistory は back() 時に popstate を同期 dispatch するため、非同期順序の
  // 実証は SearchPalette.historyIntegration.test.tsx (実 jsdom history) 側で行う。
  it('requestCloseThen runs the callback when the popstate for its own entry arrives', () => {
    const onClose = vi.fn();
    const run = vi.fn();

    const { result } = renderHook(() =>
      useHistoryBackClose({
        panelId: 'search',
        onClose,
        enabled: true,
      }),
    );

    act(() => {
      result.current.requestCloseThen(run);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fakeHistory.back).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('requestCloseThen calls onClose before run', () => {
    const order: string[] = [];
    const onClose = vi.fn(() => {
      order.push('onClose');
    });
    const run = vi.fn(() => {
      order.push('run');
    });

    const { result } = renderHook(() =>
      useHistoryBackClose({
        panelId: 'search',
        onClose,
        enabled: true,
      }),
    );

    act(() => {
      result.current.requestCloseThen(run);
    });

    expect(order).toEqual(['onClose', 'run']);
  });

  it('requestCloseThen runs the callback via fallback when popstate never arrives', () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const run = vi.fn();

      vi.spyOn(window.history, 'back').mockImplementation(() => {});

      const { result } = renderHook(() =>
        useHistoryBackClose({
          panelId: 'search',
          onClose,
          enabled: true,
        }),
      );

      act(() => {
        result.current.requestCloseThen(run);
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requestCloseThen runs the callback under StrictMode without waiting for fallback (bdboard-h4xs.7 regression)', async () => {
    const onClose = vi.fn();
    const run = vi.fn();

    const { result } = renderHook(
      () =>
        useHistoryBackClose({
          panelId: 'search',
          onClose,
          enabled: true,
        }),
      { wrapper: StrictMode },
    );

    // StrictMode の「マウント→クリーンアップ→再マウント」で同一トークンのエントリが
    // 2つ積まれる。requestCloseThen の back() 着地先が重複エントリになると、
    // トークン照合付き一発リスナでは finish() に到達できず run() が500ms待ちになる。
    await act(async () => {
      await Promise.resolve();
    });

    expect(fakeHistory.pushState).toHaveBeenCalledTimes(2);
    const token0 = (
      fakeHistory.pushState.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    )?.bdboardPanelToken;
    const token1 = (
      fakeHistory.pushState.mock.calls[1]?.[0] as Record<string, unknown> | undefined
    )?.bdboardPanelToken;
    expect(token0).toBe(token1);

    act(() => {
      result.current.requestCloseThen(run);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fakeHistory.back).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('requestCloseThen calls onClose even when run throws, and does not propagate', () => {
    const onClose = vi.fn();
    const run = vi.fn(() => {
      throw new Error('action failed');
    });

    const { result } = renderHook(() =>
      useHistoryBackClose({
        panelId: 'search',
        onClose,
        enabled: true,
      }),
    );

    // run() は popstate リスナ内で実行される。jsdom / 実ブラウザとも listener 内の
    // 例外は uncaught error として報告され、dispatchEvent の呼び出し元へは伝播しない。
    // だからこそ onClose() を history.back() より前に呼んでおく必要がある — 呼び出し元の
    // クリックハンドラが run の throw に巻き添えにならないよう、閉じ処理は先に確定させる。
    const suppressExpectedUncaughtError = (event: ErrorEvent) => {
      if (event.message.includes('action failed')) {
        // 意図的に発生させた例外の stderr ノイズを抑えるだけ。エラーを握り潰す意図はない。
        event.preventDefault();
      }
    };
    window.addEventListener('error', suppressExpectedUncaughtError);
    try {
      expect(() => {
        act(() => {
          result.current.requestCloseThen(run);
        });
      }).not.toThrow();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('error', suppressExpectedUncaughtError);
    }
  });
});
