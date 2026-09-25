import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PrBadgeDto } from '../../api';
import { EMPTY_BOARD_FILTER } from '../../boardFilter';
import type { BoardFilterState } from '../../hooks/useBoardFilterState';
import type { UseNotificationEventsResult } from '../../hooks/useNotificationEvents';
import type { ViewMode } from '../../uiPersistedState';
import type { NextUpRunLoopController } from '../nextUpRunLoop';
import { AppViewContent, type AppViewContentProps } from './AppViewContent';

// bdboard-62p4 PR-2: AppViewContent は「どの view のときにどの子コンポーネントを
// 出すか」という出し分けロジックが全てなので、各子をモックに置き換えて view
// ごとに正しいものが描画されることを直接検証する。ボード系ビュー
// (split) の出し分け自体は AppBoardViewSwitch.test.tsx が見ているので、
// ここでは「AppViewContent が AppBoardViewSwitch を無条件に描画し、view を
// そのまま渡すこと」「AppBoardViewSwitch へ渡す boardMeta の再ピックが
// 元の値を落とさず・すり替えずに転送されること」を確認する(自己ゲートは
// AppBoardViewSwitch 側の責務)。
//
// opus レビュー指摘(PR#654): 初版は AppBoardViewSwitch を丸ごとモックしていた
// ため、AppViewContent.tsx 内の boardMeta 再ピック(pendingDecisionIds 等を
// 個別にコピーし直す箇所)がテストで一切検証されていなかった。以降は
// vi.mocked(AppBoardViewSwitch).mock.calls で実際に渡された props を検証する。

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

import { AppBoardViewSwitch } from './AppBoardViewSwitch';

const appBoardViewSwitchMock = vi.mocked(AppBoardViewSwitch);

// AppBoardViewSwitch は AppViewContent 側では view に関わらず無条件に描画される
// (split の自己ゲートは AppBoardViewSwitch 自身が持つ。
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
    view: 'split',
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
      batchRun: {} as unknown as NextUpRunLoopController,
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
    for (const view of ['split', 'activity', 'settings'] as ViewMode[]) {
      const { unmount } = render(<AppViewContent {...makeProps({ view })} />);
      expect(screen.getByTestId('board-view-switch')).toBeInTheDocument();
      unmount();
    }
  });

  it('forwards the actual view (not a hard-coded value) to AppBoardViewSwitch', () => {
    // "view をそのまま渡すこと" を直接検証する: AppBoardViewSwitch はモック
    // されているため描画結果からは view の値を確認できない。呼び出し引数を
    // 直接見ることで、view がハードコードされていないことを保証する。
    for (const view of ['split', 'digest'] as ViewMode[]) {
      const { unmount } = render(<AppViewContent {...makeProps({ view })} />);
      expect(appBoardViewSwitchMock.mock.calls.at(-1)?.[0]).toMatchObject({ view });
      unmount();
    }
  });

  it('re-picks the boardMeta subset passed to AppBoardViewSwitch without dropping or defaulting any field', () => {
    // opus レビュー指摘の変異「boardMeta の再ピックで pendingDecisionIds が
    // 空の Set にすり替わる」を直接検知する。区別可能なマーカー値を使い、
    // AppViewContent.tsx の個別コピー(projectNames/projectActiveSessions/
    // pendingDecisionIds/prLinksById/wipLimitsOverrides/selectedProjectIdsJoined)
    // が実際に転送されることを確認する。
    const projectNames = new Map([['proj-1', 'Project One']]);
    const projectActiveSessions = new Map([['proj-1', 3]]);
    const pendingDecisionIds = new Set(['bdboard-pending-marker']);
    const prLinksById = new Map<string, PrBadgeDto>([
      ['bdboard-pr-marker', { ticketId: 'bdboard-pr-marker', projectId: 'proj-1', url: 'https://example.test/9', state: 'open', checkStatus: null }],
    ]);
    const wipLimitsOverrides = { inProgressWipLimit: 4 };
    const board = {
      query: { data: undefined, isLoading: false, error: null },
      cardsById: new Map(),
      availableLabels: ['marker-label'],
    };
    const nextUp = {
      batchRun: { id: 'marker-batch-run' } as unknown as NextUpRunLoopController,
    };
    const onCardClick = vi.fn();
    const onSessionBadgeClick = vi.fn();

    render(
      <AppViewContent
        {...makeProps({
          view: 'split',
          board,
          boardMeta: {
            projectNames,
            projectActiveSessions,
            projectRootPaths: new Map([['proj-1', '/should/not/reach/board-meta']]),
            pendingDecisionIds,
            prLinksById,
            wipLimitsOverrides,
            selectedProjectIds: ['proj-1'],
            selectedProjectIdsJoined: 'proj-1',
          },
          onCardClick,
          onSessionBadgeClick,
          nextUp,
        })}
      />,
    );

    const props = appBoardViewSwitchMock.mock.calls.at(-1)?.[0];
    expect(props).toMatchObject({
      board,
      onCardClick,
      onSessionBadgeClick,
      nextUp,
      boardMeta: {
        projectNames,
        projectActiveSessions,
        pendingDecisionIds,
        prLinksById,
        wipLimitsOverrides,
        selectedProjectIdsJoined: 'proj-1',
      },
    });
    // projectRootPaths/selectedProjectIds は AppBoardViewSwitch が使わない
    // フィールドなので再ピックに含まれない(HygienePanel/ActivityFeed 等の
    // 非ボード leaf 側でだけ使う)。誤って混入していないことも見ておく。
    expect(props?.boardMeta).not.toHaveProperty('projectRootPaths');
    expect(props?.boardMeta).not.toHaveProperty('selectedProjectIds');
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

  it('renders no non-board leaf view for the board view (split)', () => {
    for (const view of ['split'] as ViewMode[]) {
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
