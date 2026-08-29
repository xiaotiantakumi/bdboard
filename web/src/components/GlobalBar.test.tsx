import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GlobalBar } from './GlobalBar';

function renderGlobalBar(overrides?: Partial<React.ComponentProps<typeof GlobalBar>>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onViewChange = vi.fn();
  const props: React.ComponentProps<typeof GlobalBar> = {
    view: 'merged',
    onViewChange,
    notificationUnreadCount: 0,
    onOpenSearch: vi.fn(),
    streamState: 'open',
    lastContactAtMs: Date.now(),
    generatedAt: null,
    lastRefreshAt: null,
    totalSessionCount: 0,
    activeSessionCount: 0,
    onOpenSessionList: vi.fn(),
    statusDetailOpen: false,
    onStatusDetailOpenChange: vi.fn(),
    projects: [],
    selectedProjectIds: [],
    onToggleProject: vi.fn(),
    onSelectAllProjects: vi.fn(),
    onClearAllProjects: vi.fn(),
    onSaveProjectCombination: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenTunnel: vi.fn(),
    onOpenHelp: vi.fn(),
    onOpenShortcuts: vi.fn(),
    ...overrides,
  };
  render(
    <QueryClientProvider client={queryClient}>
      <GlobalBar {...props} />
    </QueryClientProvider>,
  );
  return { ...props, onViewChange };
}

describe('GlobalBar view switcher a11y', () => {
  it('marks the active view with aria-current and omits it on inactive views', () => {
    renderGlobalBar({ view: 'next' });

    expect(screen.getByRole('button', { name: 'Next Up' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: '統合' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: '統計' })).not.toHaveAttribute('aria-current');
  });

  it('does not use aria-pressed on view switcher buttons', () => {
    renderGlobalBar({ view: 'merged' });

    expect(screen.getByRole('button', { name: '統合' })).not.toHaveAttribute('aria-pressed');
  });

  it('calls onViewChange when a view button is clicked', async () => {
    const user = userEvent.setup();
    const { onViewChange } = renderGlobalBar({ view: 'merged' });

    await user.click(screen.getByRole('button', { name: '統計' }));

    expect(onViewChange).toHaveBeenCalledWith('stats');
  });
});
