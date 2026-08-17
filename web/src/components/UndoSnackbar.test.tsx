import { render, screen, waitFor } from '@testing-library/react';
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
