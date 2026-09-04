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

    render(<TipsBanner onOpenHelp={onOpenHelp} onDismiss={vi.fn()} />);

    expect(screen.getByText(TIPS[0].title)).toBeInTheDocument();
    expect(screen.getByText(TIPS[0].text)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '詳しく' }));
    expect(onOpenHelp).toHaveBeenCalledOnce();
  });

  it('shows a different tip and calls onDismiss when closed (bdboard-h4xs.17)', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    render(<TipsBanner onOpenHelp={vi.fn()} onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: '次のTipsを見る' }));
    expect(screen.getByText(TIPS[1].title)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Tipsを閉じる' }));
    /*
     * bdboard-h4xs.17: 表示可否(永続化)は App.tsx 側が持つため、この
     * コンポーネント自身は閉じるボタンで onDismiss を呼ぶだけで、
     * 自分の DOM を消しはしない (isVisible state を削除済み)。
     */
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('使い方のヒント')).toBeInTheDocument();
  });
});
