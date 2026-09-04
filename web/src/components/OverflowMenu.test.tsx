import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateCheckDto } from '../api';
import { OverflowMenu } from './OverflowMenu';

const STORAGE_KEY = 'bdboard.updateCheck.v1';

const defaultProps = {
  onOpenSettings: vi.fn(),
  onOpenTunnel: vi.fn(),
  onOpenHelp: vi.fn(),
  onOpenShortcuts: vi.fn(),
  tipsBannerDismissed: false,
  onShowTipsBanner: vi.fn(),
};

function renderMenu(overrides?: Partial<React.ComponentProps<typeof OverflowMenu>>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OverflowMenu {...defaultProps} {...overrides} />
    </QueryClientProvider>,
  );
}

describe('OverflowMenu update indicator', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('shows dot and update link when cached update is available', async () => {
    const stored: UpdateCheckDto = {
      state: 'update-available',
      currentVersion: '1.0.0',
      latestVersion: 'v2.0.0',
      releaseUrl: 'https://github.com/example/release',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const user = userEvent.setup();
    renderMenu();

    const button = screen.getByRole('button', { name: 'その他のメニュー (更新あり)' });
    expect(button.querySelector('.overflow-menu-update-dot')).not.toBeNull();

    await user.click(button);
    const link = screen.getByRole('menuitem', {
      name: '新しいバージョン v2.0.0 が公開されています',
    });
    expect(link).toHaveAttribute('href', 'https://github.com/example/release');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows nothing when no cached update', () => {
    renderMenu();

    const button = screen.getByRole('button', { name: 'その他のメニュー' });
    expect(button.querySelector('.overflow-menu-update-dot')).toBeNull();
    expect(screen.queryByRole('link', { name: /新しいバージョン/ })).toBeNull();
  });

  it('shows nothing when cached state is up-to-date', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: 'up-to-date', currentVersion: '1.0.0' } satisfies UpdateCheckDto),
    );

    renderMenu();

    expect(screen.getByRole('button', { name: 'その他のメニュー' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'その他のメニュー (更新あり)' })).toBeNull();
    expect(screen.queryByRole('link', { name: /新しいバージョン/ })).toBeNull();
  });
});

describe('OverflowMenu tips banner recovery (bdboard-h4xs.17)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('hides the "Tips バナーを表示" item when the banner is not dismissed', async () => {
    const user = userEvent.setup();
    renderMenu({ tipsBannerDismissed: false });

    await user.click(screen.getByRole('button', { name: 'その他のメニュー' }));

    expect(
      screen.queryByRole('menuitem', { name: 'Tips バナーを表示' }),
    ).not.toBeInTheDocument();
  });

  it('shows the item and calls onShowTipsBanner when the banner is dismissed', async () => {
    const user = userEvent.setup();
    const onShowTipsBanner = vi.fn();
    renderMenu({ tipsBannerDismissed: true, onShowTipsBanner });

    await user.click(screen.getByRole('button', { name: 'その他のメニュー' }));
    await user.click(screen.getByRole('menuitem', { name: 'Tips バナーを表示' }));

    expect(onShowTipsBanner).toHaveBeenCalledOnce();
  });
});
