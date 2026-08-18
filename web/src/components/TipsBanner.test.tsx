import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIPS } from '../tipsContent';
import { TipsBanner } from './TipsBanner';

describe('TipsBanner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a tip derived from the help content and opens its detail action', async () => {
    const user = userEvent.setup();
    const onOpenHelp = vi.fn();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    render(<TipsBanner onOpenHelp={onOpenHelp} />);

    expect(screen.getByText(TIPS[0].title)).toBeInTheDocument();
    expect(screen.getByText(TIPS[0].text)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '詳しく' }));
    expect(onOpenHelp).toHaveBeenCalledOnce();
  });

  it('shows a different tip and can be dismissed', async () => {
    const user = userEvent.setup();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    render(<TipsBanner onOpenHelp={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '次のTipsを見る' }));
    expect(screen.getByText(TIPS[1].title)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Tipsを閉じる' }));
    expect(screen.queryByLabelText('使い方のヒント')).not.toBeInTheDocument();
  });
});
