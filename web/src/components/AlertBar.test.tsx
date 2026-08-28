import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertBar } from './AlertBar';

const FIXED_NOW_MS = new Date('2026-01-01T12:00:00.000Z').getTime();

vi.mock('../hooks/useNow', () => ({
  useNow: () => FIXED_NOW_MS,
}));

describe('AlertBar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a quiet reconnecting message when streamState is reconnecting', () => {
    render(
      <AlertBar
        streamState="reconnecting"
        lastContactAtMs={FIXED_NOW_MS}
        onRefresh={vi.fn()}
        isRefreshing={false}
        onOpenDetails={vi.fn()}
      />,
    );

    expect(screen.getByText('サーバーと再接続しています…')).toBeInTheDocument();
    expect(screen.queryByText('盤面データの接続が切断されています')).not.toBeInTheDocument();
    expect(screen.getByRole('status').className).toContain('alert-bar-quiet');
  });

  it('shows the disconnected message when streamState is error', () => {
    render(
      <AlertBar
        streamState="error"
        lastContactAtMs={FIXED_NOW_MS}
        onRefresh={vi.fn()}
        isRefreshing={false}
        onOpenDetails={vi.fn()}
      />,
    );

    expect(screen.getByText('盤面データの接続が切断されています')).toBeInTheDocument();
    expect(screen.queryByText('サーバーと再接続しています…')).not.toBeInTheDocument();
  });

  it('calls onRefresh when the reconnect button is clicked', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    render(
      <AlertBar
        streamState="reconnecting"
        lastContactAtMs={FIXED_NOW_MS}
        onRefresh={onRefresh}
        isRefreshing={false}
        onOpenDetails={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '再接続' }));

    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
