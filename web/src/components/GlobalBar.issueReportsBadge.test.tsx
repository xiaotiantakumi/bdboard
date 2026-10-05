import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildPaletteActions } from '../paletteActions';
import { VIEW_ITEMS } from '../uiPersistedState';
import { GlobalBar } from './GlobalBar';

function renderBar(issueReportPendingCount: number | null | undefined) {
  const props: React.ComponentProps<typeof GlobalBar> = {
    view: 'split',
    onViewChange: vi.fn(),
    notificationUnreadCount: 0,
    ...(issueReportPendingCount !== undefined ? { issueReportPendingCount } : {}),
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
    tipsBannerDismissed: false,
    onShowTipsBanner: vi.fn(),
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GlobalBar {...props} />
    </QueryClientProvider>,
  );
}

describe('GlobalBar issue report tab (bdboard-4y8q.3.2)', () => {
  it('places 不具合報告 between イベント and 設定', () => {
    const labels = VIEW_ITEMS.map((item) => item.label);
    expect(labels.indexOf('不具合報告')).toBe(labels.indexOf('イベント') + 1);
    expect(labels.indexOf('設定')).toBe(labels.indexOf('不具合報告') + 1);
  });

  it('shows the pending count on the tab when there is at least one', () => {
    renderBar(2);
    // 書式は隣のイベントのタブ (「イベント (3)」) にそろえる。ボタン名に件数が入る。
    expect(screen.getByRole('button', { name: '不具合報告 (2)' })).toBeInTheDocument();
  });

  it.each([0, null, undefined])('shows no count when the count is %s', (count) => {
    renderBar(count);
    expect(screen.getByRole('button', { name: /^不具合報告/ }).textContent).toBe('不具合報告');
  });

  it('can be opened from the command palette', () => {
    const onViewChange = vi.fn();
    const actions = buildPaletteActions({
      onViewChange,
      onOpenChat: vi.fn(),
      onToggleHideDone: vi.fn(),
      hideDone: false,
      onToggleStalledOnly: vi.fn(),
      stalledOnly: false,
      onOpenSessionList: vi.fn(),
      onOpenHelp: vi.fn(),
      onRefresh: vi.fn(),
      chatAvailable: false,
    });
    const action = actions.find((candidate) => candidate.label === 'ビュー: 不具合報告');
    action?.onSelect();
    expect(onViewChange).toHaveBeenCalledWith('issue-reports');
  });
});
