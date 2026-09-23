import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BOARD_FILTER } from '../../boardFilter';
import type { BoardFilterState } from '../../hooks/useBoardFilterState';
import type { UseNotificationEventsResult } from '../../hooks/useNotificationEvents';
import type { ViewMode } from '../../uiPersistedState';
import type { NextUpRunLoopController } from '../next-up/run-loop/types';
import { AppViewContent, type AppViewContentProps } from './AppViewContent';

// bdboard-62p4 PR-2: AppViewContent は「どの view のときにどの子コンポーネントを
// 出すか」という出し分けロジックが全てなので、各子をモックに置き換えて view
// ごとに正しいものが描画されることを直接検証する。ボード系ビュー
// (merged/split/next) の出し分け自体は AppBoardViewSwitch.test.tsx が見ているので、
// ここでは「AppViewContent が AppBoardViewSwitch を無条件に描画し、view を
// そのまま渡すこと」だけを確認する(自己ゲートは AppBoardViewSwitch 側の責務)。

vi.mock('./AppBoardViewSwitch', () => ({
  AppBoardViewSwitch: vi.fn(() => <div data-testid="board-view-switch" />),
}));
vi.mock('../ActivityFeed', () => ({
  ActivityFeed: vi.fn((props: { windowDays: number }) => (
    <div data-testid="activity-feed">{props.windowDays}</div>
  )),
}));
vi.mock('../DailyDigest', () => ({
  DailyDigest: vi.fn((props: { windowDays: number }) => (
    <div data-testid="daily-digest">{props.windowDays}</div>
  )),
}));
vi.mock('../ThroughputStats', () => ({
  ThroughputStats: vi.fn((props: { weeks: number }) => (
    <div data-testid="throughput-stats">{props.weeks}</div>
  )),
}));
vi.mock('../HygienePanel', () => ({
  HygienePanel: vi.fn(() => <div data-testid="hygiene-panel" />),
}));
vi.mock('../DependencyGraphView', () => ({
  DependencyGraphView: vi.fn((props: { focusTicketId?: string }) => (
    <div data-testid="dependency-graph-view">{props.focusTicketId ?? ''}</div>
  )),
}));
vi.mock('../SettingsPanel', () => ({
  SettingsPanel: vi.fn(() => <div data-testid="settings-panel" />),
}));
vi.mock('../EventCenterPanel', () => ({
  EventCenterPanel: vi.fn((props: { unreadCount: number }) => (
    <div data-testid="event-center-panel">{props.unreadCount}</div>
  )),
}));

// AppBoardViewSwitch は AppViewContent 側では view に関わらず無条件に描画される
// (merged/split/next の自己ゲートは AppBoardViewSwitch 自身が持つ。
// AppBoardViewSwitch.test.tsx の「非ボードビューでは何も描画しない」テストが
// その自己ゲートを直接検証している)。よってここでの排他性チェックの対象は
// ボード以外のリーフ view だけにする。
const LEAF_TESTIDS = [
  'activity-feed',
  'daily-digest',
  'throughput-stats',
  'hygiene-panel',
  'dependency-graph-view',
  'settings-panel',
  'event-center-panel',
];

function makeFilterState(): BoardFilterState {
  return {
    priorityCeiling: 'all',
    setPriorityCeiling: vi.fn(),
    issueTypes: [],
    setIssueTypes: vi.fn(),
    labels: [],
    setLabels: vi.fn(),
    filterText: '',
    setFilterText: vi.fn(),
    hideDone: false,
    setHideDone: vi.fn(),
    stalledOnly: false,
    setStalledOnly: vi.fn(),
    collapsedLanes: [],
    collapsedLanesSet: new Set(),
    onToggleLaneCollapse: vi.fn(),
    filter: EMPTY_BOARD_FILTER,
  };
}

function makeNotificationEvents(): UseNotificationEventsResult {
  return {
    events: [],
    unreadCount: 3,
    lastReadAt: null,
    markAllRead: vi.fn(),
    notificationsEnabled: false,
    notificationsSupported: false,
    permission: 'default',
    enableNotifications: vi.fn(),
    disableNotifications: vi.fn(),
    notificationDeliveryError: null,
  };
}

function makeProps(overrides: Partial<AppViewContentProps> = {}): AppViewContentProps {
  return {
    view: 'merged',
    filterState: makeFilterState(),
    epicFilterId: undefined,
    onClearEpicFilter: vi.fn(),
    board: {
      query: { data: undefined, isLoading: false, error: null },
      cardsById: new Map(),
      availableLabels: [],
    },
    boardMeta: {
      projectNames: new Map(),
      projectActiveSessions: new Map(),
      projectRootPaths: new Map(),
      pendingDecisionIds: new Set(),
      prLinksById: new Map(),
      wipLimitsOverrides: {},
      selectedProjectIds: [],
      selectedProjectIdsJoined: '',
    },
    selectedTicketId: null,
    onCardClick: vi.fn(),
    onSessionBadgeClick: vi.fn(),
    nextUp: {
      limit: 10,
      onLimitChange: vi.fn(),
      showEpics: false,
      onShowEpicsChange: vi.fn(),
      batchRun: {} as unknown as NextUpRunLoopController,
      harnessStatuses: undefined,
    },
    windows: {
      activityWindowDays: 1,
      onActivityWindowDaysChange: vi.fn(),
      digestWindowDays: 1,
      onDigestWindowDaysChange: vi.fn(),
      statsWeeks: 8,
      onStatsWeeksChange: vi.fn(),
    },
    notificationEvents: makeNotificationEvents(),
    ...overrides,
  };
}

function expectOnlyLeaf(testid: string | null) {
  for (const id of LEAF_TESTIDS) {
    if (id === testid) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    } else {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
  }
}

describe('AppViewContent', () => {
  it('always delegates to AppBoardViewSwitch regardless of view (self-gating lives there)', () => {
    for (const view of ['merged', 'split', 'next', 'activity', 'settings'] as ViewMode[]) {
      const { unmount } = render(<AppViewContent {...makeProps({ view })} />);
      expect(screen.getByTestId('board-view-switch')).toBeInTheDocument();
      unmount();
    }
  });

  const leafCases: { view: ViewMode; testid: string }[] = [
    { view: 'activity', testid: 'activity-feed' },
    { view: 'digest', testid: 'daily-digest' },
    { view: 'stats', testid: 'throughput-stats' },
    { view: 'hygiene', testid: 'hygiene-panel' },
    { view: 'graph', testid: 'dependency-graph-view' },
    { view: 'settings', testid: 'settings-panel' },
    { view: 'events', testid: 'event-center-panel' },
  ];

  for (const { view, testid } of leafCases) {
    it(`renders exactly one non-board view (${testid}) for view=${view}`, () => {
      const { unmount } = render(<AppViewContent {...makeProps({ view })} />);
      expectOnlyLeaf(testid);
      unmount();
    });
  }

  it('renders no non-board leaf view for the board views (merged/split/next)', () => {
    for (const view of ['merged', 'split', 'next'] as ViewMode[]) {
      const { unmount } = render(<AppViewContent {...makeProps({ view })} />);
      expectOnlyLeaf(null);
      unmount();
    }
  });

  it('forwards windows state to the matching view (activity/digest/stats)', () => {
    const { rerender } = render(
      <AppViewContent
        {...makeProps({
          view: 'activity',
          windows: {
            activityWindowDays: 7,
            onActivityWindowDaysChange: vi.fn(),
            digestWindowDays: 1,
            onDigestWindowDaysChange: vi.fn(),
            statsWeeks: 8,
            onStatsWeeksChange: vi.fn(),
          },
        })}
      />,
    );
    expect(screen.getByTestId('activity-feed')).toHaveTextContent('7');

    rerender(
      <AppViewContent
        {...makeProps({
          view: 'digest',
          windows: {
            activityWindowDays: 1,
            onActivityWindowDaysChange: vi.fn(),
            digestWindowDays: 7,
            onDigestWindowDaysChange: vi.fn(),
            statsWeeks: 8,
            onStatsWeeksChange: vi.fn(),
          },
        })}
      />,
    );
    expect(screen.getByTestId('daily-digest')).toHaveTextContent('7');

    rerender(
      <AppViewContent
        {...makeProps({
          view: 'stats',
          windows: {
            activityWindowDays: 1,
            onActivityWindowDaysChange: vi.fn(),
            digestWindowDays: 1,
            onDigestWindowDaysChange: vi.fn(),
            statsWeeks: 4,
            onStatsWeeksChange: vi.fn(),
          },
        })}
      />,
    );
    expect(screen.getByTestId('throughput-stats')).toHaveTextContent('4');
  });

  it('forwards selectedTicketId as the graph focusTicketId', () => {
    render(<AppViewContent {...makeProps({ view: 'graph', selectedTicketId: 'bdboard-xyz' })} />);
    expect(screen.getByTestId('dependency-graph-view')).toHaveTextContent('bdboard-xyz');
  });

  it('spreads notificationEvents into EventCenterPanel', () => {
    render(
      <AppViewContent
        {...makeProps({
          view: 'events',
          notificationEvents: { ...makeNotificationEvents(), unreadCount: 42 },
        })}
      />,
    );
    expect(screen.getByTestId('event-center-panel')).toHaveTextContent('42');
  });
});
