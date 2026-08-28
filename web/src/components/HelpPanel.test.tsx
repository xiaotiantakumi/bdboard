import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelpPanel } from './HelpPanel';

describe('HelpPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the help dialog and major feature sections', () => {
    render(<HelpPanel onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'ヘルプ' })).toBeInTheDocument();
    expect(screen.getByText('bdboard バージョン', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.getByText(`v${__BDBOARD_VERSION__}`)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Kanban（看板）' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '依存グラフ' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '統計' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'チャット' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'トンネル公開とQR' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '設定' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<HelpPanel onClose={onClose} />);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the overlay backdrop is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<HelpPanel onClose={onClose} />);

    const overlay = container.querySelector('.help-panel-overlay');
    expect(overlay).not.toBeNull();
    await user.click(overlay!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when the panel content is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<HelpPanel onClose={onClose} />);

    await user.click(screen.getByRole('heading', { name: 'Kanban（看板）' }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes via the close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<HelpPanel onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: '閉じる' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
