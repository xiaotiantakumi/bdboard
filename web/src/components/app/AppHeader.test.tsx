import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppHeaderProps } from './AppHeader';

// bdboard-62p4 第4段: AppHeader は GlobalBar/ViewToolbar をラップして
// グループ化した props を平たい個別 props へ展開するだけの配線コンポーネント。
// GlobalBar/ViewToolbar 自体をモックに置き換え、AppHeader へ渡した
// グループ化 props がそのまま(prop名・値を変えずに)転送されることを
// vi.mocked(X).mock.calls で直接検証する(AppViewContent.test.tsx と同じ手法。
// 浅いレンダーだけのテストは配線バグを検知できないという opus レビュー指摘
// (PR#654) を踏まえたもの)。
vi.mock('../GlobalBar', () => ({
  GlobalBar: vi.fn(() => <div data-testid="global-bar" />),
}));
vi.mock('../ViewToolbar', () => ({
  ViewToolbar: vi.fn(() => <div data-testid="view-toolbar" />),
}));

import { GlobalBar } from '../GlobalBar';
import { ViewToolbar } from '../ViewToolbar';
import { AppHeader } from './AppHeader';

const globalBarMock = vi.mocked(GlobalBar);
const viewToolbarMock = vi.mocked(ViewToolbar);

// マーカー値: 引数の取り違え(例えば sessions.total と sessions.active の
// 入れ替わり)を確実に検知できるよう、同じ形の値でもフィールドごとに異なる
// 識別可能な値にする。
function makeProps(overrides: Partial<AppHeaderProps> = {}): AppHeaderProps {
  return {
    view: 'split',
    onViewChange: vi.fn(),
    notificationUnreadCount: 7,
    onOpenSearch: vi.fn(),
    connection: {
      streamState: 'open',
      connectStalled: false,
      lastContactAtMs: 12345,
      generatedAt: '2026-09-24T00:00:00.000Z',
      lastRefreshAt: '2026-09-24T00:00:01.000Z',
    },
    sessions: {
      total: 11,
      active: 3,
      onOpen: vi.fn(),
    },
    statusDetail: {
      open: true,
      onOpenChange: vi.fn(),
    },
    projects: {
      list: [{ id: 'proj-marker', name: 'Marker Project', rootPath: '/tmp/marker' }] as never,
      selectedIds: ['proj-marker'],
      onToggle: vi.fn(),
      onSelectAll: vi.fn(),
      onClearAll: vi.fn(),
      onSaveCombination: vi.fn(),
    },
    onOpenSettings: vi.fn(),
    onOpenTunnel: vi.fn(),
    onOpenHelp: vi.fn(),
    onOpenShortcuts: vi.fn(),
    tipsBanner: {
      dismissed: true,
      onShow: vi.fn(),
    },
    toolbar: {
      boardFilterPresets: [],
      onBoardFilterPresetsChange: vi.fn(),
      boardFilterPresetState: {
        view: 'split',
        selectedProjectIds: ['proj-marker'],
        priorityCeiling: 'all',
        issueTypes: [],
        labels: [],
        filterText: '',
        hideDone: true,
        stalledOnly: false,
      },
      onApplyBoardFilterPreset: vi.fn(),
      hideDone: true,
      onHideDoneChange: vi.fn(),
      stalledOnly: false,
      onStalledOnlyChange: vi.fn(),
      onRefresh: vi.fn(),
      isRefreshing: false,
      chatAvailable: true,
      onOpenChat: vi.fn(),
      presetSaveIntentToken: 4,
    },
    ...overrides,
  };
}

describe('AppHeader', () => {
  it('forwards the grouped props to GlobalBar under their original flat prop names', () => {
    const props = makeProps();
    render(<AppHeader {...props} />);

    const globalBarProps = globalBarMock.mock.calls.at(-1)![0];

    expect(globalBarProps.view).toBe('split');
    expect(globalBarProps.onViewChange).toBe(props.onViewChange);
    expect(globalBarProps.notificationUnreadCount).toBe(7);
    expect(globalBarProps.onOpenSearch).toBe(props.onOpenSearch);
    expect(globalBarProps.streamState).toBe('open');
    expect(globalBarProps.connectStalled).toBe(false);
    expect(globalBarProps.lastContactAtMs).toBe(12345);
    expect(globalBarProps.generatedAt).toBe('2026-09-24T00:00:00.000Z');
    expect(globalBarProps.lastRefreshAt).toBe('2026-09-24T00:00:01.000Z');
    expect(globalBarProps.totalSessionCount).toBe(11);
    expect(globalBarProps.activeSessionCount).toBe(3);
    expect(globalBarProps.statusDetailOpen).toBe(true);
    expect(globalBarProps.onStatusDetailOpenChange).toBe(props.statusDetail.onOpenChange);
    expect(globalBarProps.projects).toBe(props.projects.list);
    expect(globalBarProps.selectedProjectIds).toBe(props.projects.selectedIds);
    expect(globalBarProps.onToggleProject).toBe(props.projects.onToggle);
    expect(globalBarProps.onSelectAllProjects).toBe(props.projects.onSelectAll);
    expect(globalBarProps.onClearAllProjects).toBe(props.projects.onClearAll);
    expect(globalBarProps.onSaveProjectCombination).toBe(props.projects.onSaveCombination);
    expect(globalBarProps.onOpenSettings).toBe(props.onOpenSettings);
    expect(globalBarProps.onOpenTunnel).toBe(props.onOpenTunnel);
    expect(globalBarProps.onOpenHelp).toBe(props.onOpenHelp);
    expect(globalBarProps.onOpenShortcuts).toBe(props.onOpenShortcuts);
    expect(globalBarProps.tipsBannerDismissed).toBe(true);
    expect(globalBarProps.onShowTipsBanner).toBe(props.tipsBanner.onShow);
  });

  it('discards any argument GlobalBar/ViewToolbar would pass to onOpenSessionList (always calls sessions.onOpen with none)', () => {
    const props = makeProps();
    render(<AppHeader {...props} />);

    const globalBarProps = globalBarMock.mock.calls.at(-1)![0];
    const viewToolbarProps = viewToolbarMock.mock.calls.at(-1)![0];

    globalBarProps.onOpenSessionList();
    viewToolbarProps.onOpenSessionList();

    expect(props.sessions.onOpen).toHaveBeenCalledTimes(2);
    expect(props.sessions.onOpen).toHaveBeenNthCalledWith(1);
    expect(props.sessions.onOpen).toHaveBeenNthCalledWith(2);
  });

  it('forwards the grouped props to ViewToolbar under their original flat prop names', () => {
    const props = makeProps();
    render(<AppHeader {...props} />);

    const viewToolbarProps = viewToolbarMock.mock.calls.at(-1)![0];

    expect(viewToolbarProps.view).toBe('split');
    expect(viewToolbarProps.boardFilterPresets).toBe(props.toolbar.boardFilterPresets);
    expect(viewToolbarProps.onBoardFilterPresetsChange).toBe(
      props.toolbar.onBoardFilterPresetsChange,
    );
    expect(viewToolbarProps.boardFilterPresetState).toBe(props.toolbar.boardFilterPresetState);
    expect(viewToolbarProps.onApplyBoardFilterPreset).toBe(
      props.toolbar.onApplyBoardFilterPreset,
    );
    expect(viewToolbarProps.hideDone).toBe(true);
    expect(viewToolbarProps.onHideDoneChange).toBe(props.toolbar.onHideDoneChange);
    expect(viewToolbarProps.stalledOnly).toBe(false);
    expect(viewToolbarProps.onStalledOnlyChange).toBe(props.toolbar.onStalledOnlyChange);
    expect(viewToolbarProps.totalSessionCount).toBe(11);
    expect(viewToolbarProps.activeSessionCount).toBe(3);
    expect(viewToolbarProps.onRefresh).toBe(props.toolbar.onRefresh);
    expect(viewToolbarProps.isRefreshing).toBe(false);
    expect(viewToolbarProps.chatAvailable).toBe(true);
    expect(viewToolbarProps.onOpenChat).toBe(props.toolbar.onOpenChat);
    expect(viewToolbarProps.presetSaveIntentToken).toBe(4);
  });
});
