import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppHeaderProps } from './AppHeader';
import type { AppOverlayGroupProps } from './AppOverlayGroup';
import type { AppViewContentProps } from './AppViewContent';
import type { useAppController } from './useAppController';

// bdboard-62p4 第6段: App.tsx の本体を useAppController (hook) と AppBody
// (表示専用、AppHeaderSection/AppOverlaySection にさらに分割) へ分けたときの
// 「配線ミス」を検出するテスト。#654 のレビューで指摘された教訓
// (スカラーだけのモックだと配線ミスを見逃す) に従い、値そのものでは区別が
// つきにくいフィールド (真偽値2種類しかない hideDone/stalledOnly など) は
// マーカー付きオブジェクト/識別可能な文字列で見分ける。
//
// AppHeader/AppOverlayGroup/AppViewContent 自体の内部実装はそれぞれ既存の
// AppHeader.test.tsx/AppOverlayGroup.test.tsx/AppViewContent.test.tsx で
// カバー済みなので、ここでは「controller のどの値が、どの component の
// どの prop に届くか」という新しく書いたグルーコード (AppBody.tsx /
// AppHeaderSection.tsx / AppOverlaySection.tsx) だけを対象にする。
const capturedHeaderProps: AppHeaderProps[] = [];
vi.mock('./AppHeader', () => ({
  AppHeader: (props: AppHeaderProps) => {
    capturedHeaderProps.push(props);
    return null;
  },
}));

const capturedOverlayGroupProps: AppOverlayGroupProps[] = [];
vi.mock('./AppOverlayGroup', () => ({
  AppOverlayGroup: (props: AppOverlayGroupProps) => {
    capturedOverlayGroupProps.push(props);
    return null;
  },
}));

const capturedViewContentProps: AppViewContentProps[] = [];
vi.mock('./AppViewContent', () => ({
  AppViewContent: (props: AppViewContentProps) => {
    capturedViewContentProps.push(props);
    return null;
  },
}));

// AppBody は AlertBar/TipsBanner/各 Provider も直接描画するので、それらは
// 実物のままにしておく (副作用も外部依存も無い薄いコンポーネント群のため)。

type Controller = ReturnType<typeof useAppController>;

function makeBoardFilterState(
  overrides: Partial<Controller['boardFilterState']> = {},
): Controller['boardFilterState'] {
  return {
    priorityCeiling: 'all',
    setPriorityCeiling: vi.fn(),
    issueTypes: [],
    setIssueTypes: vi.fn(),
    labels: [],
    setLabels: vi.fn(),
    filterText: '',
    setFilterText: vi.fn(),
    hideDone: true,
    setHideDone: vi.fn(),
    stalledOnly: false,
    setStalledOnly: vi.fn(),
    collapsedLanes: [],
    collapsedLanesSet: new Set(),
    onToggleLaneCollapse: vi.fn(),
    filter: { priorityCeiling: null, issueTypes: [], labels: [], text: '' },
    ...overrides,
  };
}

function makeOverlays(overrides: Partial<Controller['overlays']> = {}): Controller['overlays'] {
  return {
    handleOpenSearch: vi.fn(),
    statusDetailOpen: false,
    setStatusDetailOpen: vi.fn(),
    handleOpenSessionList: vi.fn(),
    sessionListOpen: false,
    sessionListProjectId: undefined,
    handleCloseSessionList: vi.fn(),
    handleSaveProjectCombination: vi.fn(),
    handleOpenTunnel: vi.fn(),
    tunnelModalOpen: false,
    handleCloseTunnel: vi.fn(),
    handleOpenHelp: vi.fn(),
    helpOpen: false,
    handleCloseHelp: vi.fn(),
    handleOpenShortcuts: vi.fn(),
    shortcutsOpen: false,
    handleCloseShortcuts: vi.fn(),
    handleOpenStatusDetail: vi.fn(),
    handleChatAboutTicket: vi.fn(),
    detailMaximized: false,
    handleToggleDetailMaximized: vi.fn(),
    presetSaveIntentToken: 0,
    searchOpen: false,
    handleCloseSearch: vi.fn(),
    chatOpen: false,
    chatContext: undefined,
    chatContextToken: 0,
    handleCloseChat: vi.fn(),
    handleOpenChat: vi.fn(),
    ...overrides,
  };
}

function makeController(overrides: Record<string, unknown> = {}): Controller {
  const boardFilterState = makeBoardFilterState();
  const overlays = makeOverlays();
  const base = {
    view: 'split',
    setView: vi.fn(),
    selectedProjectIds: ['__marker_selected_project__'],
    setSelectedProjectIds: vi.fn(),
    selectedProjectIdsJoined: '__marker_selected_project__',
    lastChatProjectId: '__marker_last_chat_project__',
    setLastChatProjectId: vi.fn(),
    boardFilterPresets: [],
    setBoardFilterPresets: vi.fn(),
    nextUpLimit: 10,
    setNextUpLimit: vi.fn(),
    nextUpShowEpics: false,
    setNextUpShowEpics: vi.fn(),
    // activityWindowDays/digestWindowDays/statsWeeks share a type (number) and,
    // for the first two, a validator (see useAppUiPreferences.ts), so a silent
    // swap between them in AppBody's `windows={{...}}` wiring wouldn't be
    // caught by TypeScript. Giving them distinct values here (not just
    // distinct setters) lets the assertions below catch that swap.
    activityWindowDays: 7,
    setActivityWindowDays: vi.fn(),
    digestWindowDays: 3,
    setDigestWindowDays: vi.fn(),
    statsWeeks: 12,
    setStatsWeeks: vi.fn(),
    recentTickets: [],
    setRecentTickets: vi.fn(),
    tipsBannerDismissed: true,
    setTipsBannerDismissed: vi.fn(),
    boardFilterState,
    boardFilterPresetState: {
      view: 'split',
      selectedProjectIds: [],
      priorityCeiling: 'all',
      issueTypes: [],
      labels: [],
      filterText: '',
      hideDone: true,
      stalledOnly: false,
    },
    handleApplyBoardFilterPreset: vi.fn(),
    nextUpBatchRun: { __marker_next_up_batch_run__: true },
    epicFilterId: undefined,
    setEpicFilterId: vi.fn(),
    selectedTicketId: null,
    handleSelectTicket: vi.fn(),
    handleCloseDetail: vi.fn(),
    canGoBackTicket: false,
    goBackTicket: vi.fn(),
    overlays,
    projectsQuery: { data: [] },
    chatProjects: [],
    projectNames: new Map([['proj-1', '__marker_project_name__']]),
    projectActiveSessions: new Map(),
    projectRootPaths: new Map([['proj-1', '/marker/root']]),
    totalSessionCount: 0,
    activeSessionCount: 0,
    lastRefreshAt: null,
    statusErrors: [],
    boardQuery: { data: undefined, dataUpdatedAt: 0 },
    availableLabels: ['__marker_available_label__'],
    boardCardsById: new Map(),
    streamState: 'open',
    lastContactAtMs: null,
    connectStalled: false,
    pendingDecisionsById: new Map(),
    pendingDecisionIds: new Set(),
    prLinksById: new Map(),
    chatAvailable: true,
    wipLimitsOverrides: {},
    harnessStatusQuery: { data: undefined },
    harnessStatuses: new Map(),
    notificationEvents: { unreadCount: 0 },
    handleRecordRecentTicket: vi.fn(),
    isTicketOnBoard: vi.fn(),
    isRefreshing: false,
    handleRefresh: vi.fn(),
    handleToggleProject: vi.fn(),
    handleSelectAll: vi.fn(),
    handleClearAll: vi.fn(),
    paletteActions: [],
    handleFilterByEpic: vi.fn(),
    ...overrides,
  };
  return base as unknown as Controller;
}

function renderAppBody(
  AppBodyComponent: typeof import('./AppBody').AppBody,
  controller: Controller,
) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AppBodyComponent controller={controller} />
    </QueryClientProvider>,
  );
}

describe('AppBody wiring (bdboard-62p4 第6段: useAppController + AppHeaderSection/AppOverlaySection)', () => {
  it('passes boardFilterState.hideDone/stalledOnly (not a stale top-level copy) into AppHeader toolbar', async () => {
    capturedHeaderProps.length = 0;
    const { AppBody } = await import('./AppBody');
    const controller = makeController({
      boardFilterState: makeBoardFilterState({ hideDone: false, stalledOnly: true }),
    });

    renderAppBody(AppBody, controller);

    const header = capturedHeaderProps.at(-1);
    expect(header?.toolbar.hideDone).toBe(false);
    expect(header?.toolbar.stalledOnly).toBe(true);
    expect(header?.toolbar.onHideDoneChange).toBe(controller.boardFilterState.setHideDone);
    expect(header?.toolbar.onStalledOnlyChange).toBe(controller.boardFilterState.setStalledOnly);
  });

  it('passes the same hideDone/stalledOnly values to AppHeader when they flip', async () => {
    capturedHeaderProps.length = 0;
    const { AppBody } = await import('./AppBody');
    const controller = makeController({
      boardFilterState: makeBoardFilterState({ hideDone: true, stalledOnly: false }),
    });

    renderAppBody(AppBody, controller);

    const header = capturedHeaderProps.at(-1);
    expect(header?.toolbar.hideDone).toBe(true);
    expect(header?.toolbar.stalledOnly).toBe(false);
  });

  it('passes the controller boardQuery/boardFilterState by reference into AppViewContent', async () => {
    capturedViewContentProps.length = 0;
    const { AppBody } = await import('./AppBody');
    const controller = makeController();

    renderAppBody(AppBody, controller);

    const viewContent = capturedViewContentProps.at(-1);
    expect(viewContent?.board.query).toBe(controller.boardQuery);
    expect(viewContent?.filterState).toBe(controller.boardFilterState);
    expect(viewContent?.boardMeta.selectedProjectIdsJoined).toBe(
      '__marker_selected_project__',
    );
  });

  it('does not swap activityWindowDays/digestWindowDays/statsWeeks (share a type, and the first two share a validator)', async () => {
    capturedViewContentProps.length = 0;
    const { AppBody } = await import('./AppBody');
    const controller = makeController();

    renderAppBody(AppBody, controller);

    const viewContent = capturedViewContentProps.at(-1);
    expect(viewContent?.windows.activityWindowDays).toBe(7);
    expect(viewContent?.windows.onActivityWindowDaysChange).toBe(
      controller.setActivityWindowDays,
    );
    expect(viewContent?.windows.digestWindowDays).toBe(3);
    expect(viewContent?.windows.onDigestWindowDaysChange).toBe(controller.setDigestWindowDays);
    expect(viewContent?.windows.statsWeeks).toBe(12);
    expect(viewContent?.windows.onStatsWeeksChange).toBe(controller.setStatsWeeks);
  });

  it('resolves ticketDetail.pendingDecision/prLink from the controller Maps for the selected ticket', async () => {
    capturedOverlayGroupProps.length = 0;
    const { AppBody } = await import('./AppBody');
    const pendingDecisionMarker = { id: '__marker_pending_decision__' };
    const prLinkMarker = { url: '__marker_pr_link__' };
    const controller = makeController({
      selectedTicketId: 'bdboard-marker',
      pendingDecisionsById: new Map([['bdboard-marker', pendingDecisionMarker]]),
      prLinksById: new Map([['bdboard-marker', prLinkMarker]]),
    });

    renderAppBody(AppBody, controller);

    const overlayGroup = capturedOverlayGroupProps.at(-1);
    expect(overlayGroup?.ticketDetail.pendingDecision).toBe(pendingDecisionMarker);
    expect(overlayGroup?.ticketDetail.prLink).toBe(prLinkMarker);
  });

  it('omits ticketDetail.pendingDecision/prLink when no ticket is selected', async () => {
    capturedOverlayGroupProps.length = 0;
    const { AppBody } = await import('./AppBody');
    const controller = makeController({
      selectedTicketId: null,
      pendingDecisionsById: new Map([['bdboard-marker', { id: 'x' }]]),
      prLinksById: new Map([['bdboard-marker', { url: 'x' }]]),
    });

    renderAppBody(AppBody, controller);

    const overlayGroup = capturedOverlayGroupProps.at(-1);
    expect(overlayGroup?.ticketDetail.pendingDecision).toBeUndefined();
    expect(overlayGroup?.ticketDetail.prLink).toBeUndefined();
  });

  it('gates ticketDetail.onChatAboutTicket on chatAvailable, not always-on', async () => {
    capturedOverlayGroupProps.length = 0;
    const { AppBody } = await import('./AppBody');
    const controllerUnavailable = makeController({ chatAvailable: false });

    renderAppBody(AppBody, controllerUnavailable);

    expect(capturedOverlayGroupProps.at(-1)?.ticketDetail.onChatAboutTicket).toBeUndefined();

    capturedOverlayGroupProps.length = 0;
    const controllerAvailable = makeController({ chatAvailable: true });
    renderAppBody(AppBody, controllerAvailable);

    expect(capturedOverlayGroupProps.at(-1)?.ticketDetail.onChatAboutTicket).toBe(
      controllerAvailable.overlays.handleChatAboutTicket,
    );
  });
});
