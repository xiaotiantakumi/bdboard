import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { CONFLICT_WRITE_HELP } from '../writeAccessMessage';
import { UndoSnackbarProvider, useUndoSnackbar } from './UndoSnackbar';

function TriggerHarness({ onUndo }: { onUndo: () => Promise<void> }) {
  const snackbar = useUndoSnackbar();
  return (
    <button
      type="button"
      onClick={() =>
        snackbar?.showUndo({ message: 'テストアクションしました', onUndo })
      }
    >
      trigger
    </button>
  );
}

function renderHarness(onUndo: () => Promise<void>) {
  return render(
    <UndoSnackbarProvider>
      <TriggerHarness onUndo={onUndo} />
    </UndoSnackbarProvider>,
  );
}

describe('UndoSnackbar', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is not rendered before showUndo is called', () => {
    renderHarness(vi.fn(async () => {}));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the message and undo button after showUndo', async () => {
    renderHarness(vi.fn(async () => {}));
    await user.click(screen.getByRole('button', { name: 'trigger' }));

    expect(screen.getByText('テストアクションしました')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '元に戻す' })).toBeInTheDocument();
  });

  it('calls onUndo and shows success feedback when the undo button is clicked', async () => {
    const onUndo = vi.fn(async () => {});
    renderHarness(onUndo);
    await user.click(screen.getByRole('button', { name: 'trigger' }));
    await user.click(screen.getByRole('button', { name: '元に戻す' }));

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('元に戻しました')).toBeInTheDocument();
  });

  it('does not arm an auto-dismiss timer when onUndo settles after unmount', async () => {
    // bdboard-ty72: onUndo の完了はアンマウント後に届きうる。タイマーIDは ref で
    // 持っていてクリーンアップでも消しているが、その**後**に継続が走って
    // scheduleAutoDismiss すると、もう誰も片付けられないタイマーが残る。
    // 残ったタイマーは破棄済み jsdom で `window is not defined` を投げ、vitest は
    // それを「テスト環境破棄後の未捕捉エラー」としてプロセスごと exit 1 にする
    // (bdboard-ifff)。
    let settleUndo: (() => void) | undefined;
    const onUndo = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleUndo = () => {
            resolve();
          };
        }),
    );
    const { unmount } = renderHarness(onUndo);

    await user.click(screen.getByRole('button', { name: 'trigger' }));
    await user.click(screen.getByRole('button', { name: '元に戻す' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    // 「元に戻す」を押した時点で表示タイマーは解除されている。
    expect(vi.getTimerCount()).toBe(0);

    unmount();
    settleUndo?.();
    await act(async () => {
      await Promise.resolve();
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects after unmount without leaving a timer behind', async () => {
    // 失敗経路も同じ。catch はしているので未処理の rejection にはならない。
    let rejectUndo: ((error: Error) => void) | undefined;
    const onUndo = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectUndo = (error: Error) => {
            reject(error);
          };
        }),
    );
    const { unmount } = renderHarness(onUndo);

    await user.click(screen.getByRole('button', { name: 'trigger' }));
    await user.click(screen.getByRole('button', { name: '元に戻す' }));

    unmount();
    rejectUndo?.(new Error('too late'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a visible failure message instead of silently succeeding when onUndo rejects', async () => {
    const onUndo = vi.fn(async () => {
      throw new Error('issue is assigned to a different actor');
    });
    renderHarness(onUndo);
    await user.click(screen.getByRole('button', { name: 'trigger' }));
    await user.click(screen.getByRole('button', { name: '元に戻す' }));

    expect(
      await screen.findByText(
        '元に戻せませんでした: issue is assigned to a different actor',
      ),
    ).toBeInTheDocument();
  });

  it('shows a friendly conflict message (not the raw server text) when undo fails with 409', async () => {
    // bdboard-3tw.82: a priority undo conflict comes back from the server as an
    // ApiError with status 409. The snackbar must translate that into an
    // actionable Japanese message instead of surfacing the raw English error
    // body, matching the TunnelControl/ChatPanel 409-handling convention.
    const onUndo = vi.fn(async () => {
      throw new ApiError(409, 'priority changed since quick action', {
        errorMessage: 'priority changed since quick action',
      });
    });
    renderHarness(onUndo);
    await user.click(screen.getByRole('button', { name: 'trigger' }));
    await user.click(screen.getByRole('button', { name: '元に戻す' }));

    expect(
      await screen.findByText(`元に戻せませんでした: ${CONFLICT_WRITE_HELP}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/priority changed since quick action/),
    ).not.toBeInTheDocument();
  });

  it('auto-dismisses after the visible window elapses without the undo button being pressed', async () => {
    renderHarness(vi.fn(async () => {}));
    await user.click(screen.getByRole('button', { name: 'trigger' }));
    expect(screen.getByRole('status')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(8000);

    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('dismisses immediately when the close button is clicked, without invoking onUndo', async () => {
    const onUndo = vi.fn(async () => {});
    renderHarness(onUndo);
    await user.click(screen.getByRole('button', { name: 'trigger' }));
    await user.click(screen.getByRole('button', { name: '閉じる' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('auto-dismisses the success feedback after the result window elapses', async () => {
    renderHarness(vi.fn(async () => {}));
    await user.click(screen.getByRole('button', { name: 'trigger' }));
    await user.click(screen.getByRole('button', { name: '元に戻す' }));
    expect(await screen.findByText('元に戻しました')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(3000);

    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });
});
