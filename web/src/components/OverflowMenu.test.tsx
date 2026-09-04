import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateCheckDto } from '../api';
import {
  gutterForViewport,
  stubBoundingRect,
  stubClientWidth,
} from '../test/popoverViewportClampTestHelpers';
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

async function openOverflowMenu() {
  const user = userEvent.setup();
  const view = renderMenu();
  await user.click(screen.getByRole('button', { name: 'その他のメニュー' }));
  return view;
}

describe('OverflowMenu popover viewport clamp (bdboard-oeh5)', () => {
  let clientWidthSpy: ReturnType<typeof stubClientWidth> | undefined;
  let rectSpy: ReturnType<typeof stubBoundingRect> | undefined;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    clientWidthSpy?.mockRestore();
    rectSpy?.mockRestore();
    clientWidthSpy = undefined;
    rectSpy = undefined;
  });

  it('shifts left when the right-aligned popover overflows the right edge at 320px', async () => {
    const viewportWidth = 320;
    clientWidthSpy = stubClientWidth(viewportWidth);
    // {left:83, right:363} は 375px 実測値の流用。実際の320px実測は left=28,right=308 で
    // shift=0 になり、右端超過パスを exercise できないため、合成値でクランプの計算式自体を検証する。
    rectSpy = stubBoundingRect({ left: 83, right: 363 });

    const { container } = await openOverflowMenu();
    const popover = container.querySelector('.overflow-menu-popover');
    expect(popover).not.toBeNull();

    const shiftPx = Number.parseFloat(
      (popover as HTMLElement).style.getPropertyValue('--popover-shift-x'),
    );
    const gutter = gutterForViewport(viewportWidth);

    expect(shiftPx).toBeLessThan(0);
    expect(363 + shiftPx).toBeLessThanOrEqual(viewportWidth - gutter);
  });

  it('keeps --popover-shift-x at 0px when the popover already fits', async () => {
    clientWidthSpy = stubClientWidth(1280);
    rectSpy = stubBoundingRect({ left: 900, right: 1180 });

    const { container } = await openOverflowMenu();
    const popover = container.querySelector('.overflow-menu-popover');
    expect(popover).not.toBeNull();
    expect((popover as HTMLElement).style.getPropertyValue('--popover-shift-x')).toBe('0px');
  });
});
