import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HeaderRefreshButton } from './HeaderRefreshButton';

describe('HeaderRefreshButton', () => {
  it('calls onRefresh when clicked', async () => {
    const onRefresh = vi.fn();
    render(<HeaderRefreshButton onRefresh={onRefresh} isRefreshing={false} />);
    await userEvent.click(screen.getByRole('button', { name: '更新' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('is disabled while refreshing', () => {
    render(<HeaderRefreshButton onRefresh={vi.fn()} isRefreshing />);
    expect(screen.getByRole('button', { name: '更新' })).toBeDisabled();
  });

  it('announces 更新しました after a requested refresh finishes', async () => {
    const { rerender } = render(<HeaderRefreshButton onRefresh={vi.fn()} isRefreshing={false} />);
    await userEvent.click(screen.getByRole('button', { name: '更新' }));
    rerender(<HeaderRefreshButton onRefresh={vi.fn()} isRefreshing />);
    rerender(<HeaderRefreshButton onRefresh={vi.fn()} isRefreshing={false} />);
    expect(screen.getByText('更新しました')).toBeInTheDocument();
  });
});
