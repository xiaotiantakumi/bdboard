import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectDto } from './api';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BoardDnDProvider } from './components/BoardDnDProvider';
import { BulkSelectionProvider } from './components/BulkSelectionProvider';
import { UndoSnackbarProvider } from './components/UndoSnackbar';
import { PopoverCoordinatorProvider } from './components/PopoverCoordinator';
import { AlertBar } from './components/AlertBar';
import { GlobalBar } from './components/GlobalBar';
import { ViewToolbar } from './components/ViewToolbar';
import {
  createTicketRunsInvalidator,
  useNextUpRunLoopController,
} from './components/nextUpRunLoop';
import { TipsBanner } from './components/TipsBanner';
import { useWatchedTickets } from './components/WatchedTicketsProvider';
import { AppTicketDetailOverlay } from './components/app/AppTicketDetailOverlay';
import { AppSessionListOverlay } from './components/app/AppSessionListOverlay';
import { AppShortcutsOverlay } from './components/app/AppShortcutsOverlay';
import { AppHelpOverlay } from './components/app/AppHelpOverlay';
import { AppSearchOverlay } from './components/app/AppSearchOverlay';
import { AppTunnelOverlay } from './components/app/AppTunnelOverlay';
import { AppChatOverlay } from './components/app/AppChatOverlay';
import { AppViewContent } from './components/app/AppViewContent';
import { useHeaderHeightVar } from './hooks/useHeaderHeightVar';
import { useNotificationEvents } from './hooks/useNotificationEvents';
import { useWatchedTicketDetails } from './hooks/useWatchedTicketDetails';
import { usePersistedState } from './hooks/usePersistedState';
import { useBoardFilterState } from './hooks/useBoardFilterState';
import { useTicketDeepLink } from './hooks/useTicketDeepLink';
import {
  boardApiModeFromView,
  DEFAULT_VIEW,
  UI_STORAGE_KEYS,
  validateActivityWindowDays,
  validateBoolean,
  validateNextUpLimit,
  validateStatsWeeks,
  validateString,
  validateStringArray,
  validateViewMode,
  validateBoardFilterPresets,
  findDefaultBoardFilterPreset,
  hasStoredBoardFilterState,
  validateRecentTickets,
  recordRecentTicket,
  DEFAULT_TIPS_BANNER_DISMISSED,
  type BoardFilterPreset,
  type BoardFilterPresetState,
} from './uiPersistedState';
import { useLastServerContact } from './hooks/useLastServerContact';
import { useProjectsData } from './hooks/useProjectsData';
import { useSessionsData } from './hooks/useSessionsData';
import { useStatusData } from './hooks/useStatusData';
import { useBoardData } from './hooks/useBoardData';
import { usePendingDecisionsData } from './hooks/usePendingDecisionsData';
import { usePrLinksData } from './hooks/usePrLinksData';
import { useChatAvailabilityData } from './hooks/useChatAvailabilityData';
import { useBoardThresholdsData } from './hooks/useBoardThresholdsData';
import { useHarnessStatusData } from './hooks/useHarnessStatusData';
import { buildPaletteActions } from './paletteActions';
import { isTypingTarget } from './keyboardShortcuts';

export function App() {
  useHeaderHeightVar();

  const [view, setView] = usePersistedState(
    UI_STORAGE_KEYS.view,
    DEFAULT_VIEW,
    validateViewMode,
  );
  const [selectedProjectIds, setSelectedProjectIds] = usePersistedState(
    UI_STORAGE_KEYS.selectedProjectIds,
    [],
    validateStringArray,
  );
  const [lastChatProjectId, setLastChatProjectId] = usePersistedState(
    UI_STORAGE_KEYS.lastChatProjectId,
    '',
    validateString,
  );
  /*
   * ボードのフィルタ/表示切り替え状態 (優先度上限・issueType・ラベル・自由文字列・
   * doneレーン非表示・滞留のみ・レーン折りたたみ) は useBoardFilterState.ts に
   * まとめた (bdboard-62p4)。元は7つの usePersistedState 呼び出しが個別に
   * ここへ並んでいたのと同じ相対順序でフック内部から呼ばれるため、これらの
   * hook 自体の呼び出し順は変わらない。フック呼び出し全体の位置は
   * 元のブロックの先頭 (この位置) のまま据え置き、collapsedLanesSet /
   * onToggleLaneCollapse / boardFilter だけが元の定義位置 (line ~391-413) から
   * ここへ前倒しで移動している。詳細と安全性の理由は useBoardFilterState.ts の
   * JSDoc と PR 本文を参照。
   */
  const boardFilterState = useBoardFilterState();
  // bdboard-62p4 PR-2: collapsedLanesSet/onToggleLaneCollapse/filter はここでは
  // 個別に取り出さず、下の AppViewContent へ boardFilterState をそのまま渡す
  // (ビュー切替本体の JSX がそちら側に移動したため)。hideDone/stalledOnly と
  // 優先度上限・issueType・ラベル・自由文字列は ViewToolbar・
  // boardFilterPresetState・handleApplyBoardFilterPreset でも参照するため
  // 引き続きここで個別変数に分割代入する。
  const {
    priorityCeiling: boardPriorityCeiling,
    setPriorityCeiling: setBoardPriorityCeiling,
    issueTypes: boardIssueTypes,
    setIssueTypes: setBoardIssueTypes,
    labels: boardLabels,
    setLabels: setBoardLabels,
    filterText: boardFilterText,
    setFilterText: setBoardFilterText,
    hideDone,
    setHideDone,
    stalledOnly,
    setStalledOnly,
  } = boardFilterState;
  const [boardFilterPresets, setBoardFilterPresets] = usePersistedState(
    UI_STORAGE_KEYS.boardFilterPresets,
    [],
    validateBoardFilterPresets,
  );
  const [nextUpLimit, setNextUpLimit] = usePersistedState(
    UI_STORAGE_KEYS.nextUpLimit,
    10,
    validateNextUpLimit,
  );
  const [nextUpShowEpics, setNextUpShowEpics] = usePersistedState(
    UI_STORAGE_KEYS.nextUpShowEpics,
    false,
    validateBoolean,
  );
  /*
   * The batch controller deliberately lives in App, above both the
   * `key={view}` ErrorBoundary and the conditionally rendered NextUpView.
   * App already owns view-spanning UI state here, so lifting it is smaller
   * than adding a global store or Context. Switching to Kanban can unmount
   * the presentation while the app-scoped loop keeps running; returning to
   * Next Up reuses this state and shows whether it is active or completed.
   */
  const queryClient = useQueryClient();
  // 詳細パネルは自分で開始した実行しか追跡しないので、ループ由来の実行の開始・終了は
  // ここから ticket-runs に知らせる (bdboard-3tw.163)。
  const nextUpBatchRun = useNextUpRunLoopController({
    onTicketRunsChanged: createTicketRunsInvalidator(queryClient),
  });
  const [activityWindowDays, setActivityWindowDays] = usePersistedState(
    UI_STORAGE_KEYS.activityWindowDays,
    1,
    validateActivityWindowDays,
  );
  const [digestWindowDays, setDigestWindowDays] = usePersistedState(
    UI_STORAGE_KEYS.digestWindowDays,
    1,
    validateActivityWindowDays,
  );
  const [statsWeeks, setStatsWeeks] = usePersistedState(
    UI_STORAGE_KEYS.statsWeeks,
    8,
    validateStatsWeeks,
  );
  const [recentTickets, setRecentTickets] = usePersistedState(
    UI_STORAGE_KEYS.recentTickets,
    [],
    validateRecentTickets,
  );
  const [tipsBannerDismissed, setTipsBannerDismissed] = usePersistedState(
    UI_STORAGE_KEYS.tipsBannerDismissed,
    DEFAULT_TIPS_BANNER_DISMISSED,
    validateBoolean,
  );
  const [epicFilterId, setEpicFilterId] = useState<string | undefined>(undefined);
  const {
    selectedTicketId,
    selectTicket: handleSelectTicket,
    closeDetail: handleCloseDetail,
    canGoBackTicket,
    goBackTicket,
  } = useTicketDeepLink({ view, onViewChange: setView });
  /*
   * 詳細パネルの最大化 (bdboard-0hcx)。TicketDetailPanel ではなくここで持つ。
   *
   * AppTicketDetailOverlay 内の ErrorBoundary が key={selectedTicketId} を
   * 持つため（bdboard-sso1.13 で分割、旧: 下の ErrorBoundary）、パネル側で
   * useState するとチケットを1つたどるたびに remount されて最大化が解除される
   * (PR#242 opus レビュー major-1)。詳細パネルは「似ているチケット」や
   * 「← 戻る」でチケットを渡り歩く使い方をするので、その都度リセットされると
   * 使い物にならない。key の外に置いて、パネルを閉じたときだけ解除する。
   *
   * 幅 (ticketDetailPanelWidth) と違い永続化はしない。最大化は「今この一連の
   * チケットを広げて読みたい」という一時的な操作なので、次回起動時は保存済みの
   * 通常幅から始めるのが期待に近い。
   */
  const [detailMaximized, setDetailMaximized] = useState(false);
  const handleToggleDetailMaximized = useCallback(() => {
    setDetailMaximized((maximized) => !maximized);
  }, []);
  useEffect(() => {
    if (selectedTicketId === null) {
      setDetailMaximized(false);
    }
  }, [selectedTicketId]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatContext, setChatContext] = useState<
    { projectId: string; ticketId: string } | undefined
  >(undefined);
  const [chatContextToken, setChatContextToken] = useState(0);
  const [sessionListOpen, setSessionListOpen] = useState(false);
  const [sessionListProjectId, setSessionListProjectId] = useState<string | undefined>(
    undefined,
  );
  const [tunnelModalOpen, setTunnelModalOpen] = useState(false);
  const [statusDetailOpen, setStatusDetailOpen] = useState(false);
  const [presetSaveIntentToken, setPresetSaveIntentToken] = useState(0);
  // 初回起動判定は localStorage が書き戻される前(= 最初のレンダー中)に確定させる。
  const [hadStoredFilterStateAtStartup] = useState(() => hasStoredBoardFilterState());
  const defaultPresetHandledRef = useRef(false);

  const selectedProjectIdsJoined = selectedProjectIds.join(',');
  const boardApiMode = boardApiModeFromView(view);

  /*
   * データ取得 9 系統 (bdboard-62p4 PR-3)。元は9つの useQuery とそこから導く
   * useMemo/useEffect がすべて App 本体にフラットに並んでいたが、関心ごとの
   * カスタムフック (web/src/hooks/useXxxData.ts) へ抽出した。各フックの
   * queryKey/queryFn/enabled/retry と派生 useMemo の依存配列・本体は元の
   * App.tsx から1文字も変えていない — 詳細は各フックの JSDoc と PR 本文の
   * 対照表を参照。呼び出し順は元の宣言順 (projects → sessions → status →
   * board → useLastServerContact → pendingDecisions → prLinks →
   * chatAvailability → boardThresholds → harnessStatus) をそのまま維持して
   * いる。useAppBadge の呼び出し位置だけ pendingDecisions 側へ前倒しした
   * 理由は usePendingDecisionsData.ts の JSDoc を参照。
   */
  const { projectsQuery, chatProjects, projectNames, projectActiveSessions, projectRootPaths } =
    useProjectsData({ setSelectedProjectIds });

  const { totalSessionCount, activeSessionCount } = useSessionsData();

  const { statusQuery, lastRefreshAt, statusErrors } = useStatusData();

  const { boardQuery, boardTicketIds, availableLabels, boardCardsById } = useBoardData({
    boardApiMode,
    selectedProjectIds,
    selectedProjectIdsJoined,
    epicFilterId,
  });

  const { streamState, lastContactAtMs, reconnect, connectStalled } = useLastServerContact(boardQuery.dataUpdatedAt);

  const { pendingDecisionsById, pendingDecisionIds } = usePendingDecisionsData();

  const { prLinksById } = usePrLinksData(selectedProjectIds, selectedProjectIdsJoined);

  const { chatAvailable } = useChatAvailabilityData();

  const { wipLimitsOverrides } = useBoardThresholdsData();

  const { harnessStatusQuery, harnessStatuses } = useHarnessStatusData(view);

  const boardFilterPresetState = useMemo<BoardFilterPresetState>(
    () => ({
      view,
      selectedProjectIds,
      priorityCeiling: boardPriorityCeiling,
      issueTypes: boardIssueTypes,
      labels: boardLabels,
      filterText: boardFilterText,
      hideDone,
      stalledOnly,
    }),
    [
      view,
      selectedProjectIds,
      boardPriorityCeiling,
      boardIssueTypes,
      boardLabels,
      boardFilterText,
      hideDone,
      stalledOnly,
    ],
  );

  const handleApplyBoardFilterPreset = useCallback((preset: BoardFilterPreset) => {
    setView(preset.view);
    setSelectedProjectIds(preset.selectedProjectIds);
    setBoardPriorityCeiling(preset.priorityCeiling);
    setBoardIssueTypes(preset.issueTypes);
    setBoardLabels(preset.labels);
    setBoardFilterText(preset.filterText);
    setHideDone(preset.hideDone);
    setStalledOnly(preset.stalledOnly);
  }, [
    setView,
    setSelectedProjectIds,
    setBoardPriorityCeiling,
    setBoardIssueTypes,
    setBoardLabels,
    setBoardFilterText,
    setHideDone,
    setStalledOnly,
  ]);

  /*
    「既定」プリセットは、この端末にまだ絞り込み状態が1つも保存されていないとき
    (= 実質的な初回起動)にだけ自動適用する。既に自分の絞り込みを持っている利用者の
    状態を、起動のたびに勝手に上書きしないため。
  */
  useEffect(() => {
    if (defaultPresetHandledRef.current) {
      return;
    }
    defaultPresetHandledRef.current = true;
    if (hadStoredFilterStateAtStartup) {
      return;
    }
    const defaultPreset = findDefaultBoardFilterPreset(boardFilterPresets);
    if (defaultPreset !== null) {
      handleApplyBoardFilterPreset(defaultPreset);
    }
  }, [boardFilterPresets, hadStoredFilterStateAtStartup, handleApplyBoardFilterPreset]);

  const { watchedSet, stopWatching } = useWatchedTickets();
  const watchedTicketDetails = useWatchedTicketDetails(
    watchedSet,
    boardCardsById,
    stopWatching,
  );

  const notificationEvents = useNotificationEvents({
    watchedTicketIds: watchedSet,
    boardCardsById,
    watchedTicketDetails,
  });

  const handleRecordRecentTicket = useCallback(
    (entry: { id: string; title: string; projectId: string }) => {
      setRecentTickets((current) =>
        recordRecentTicket(current, {
          id: entry.id,
          title: entry.title,
          projectName: projectNames.get(entry.projectId) ?? entry.projectId,
        }),
      );
    },
    [projectNames, setRecentTickets],
  );

  const isTicketOnBoard = useCallback(
    (ticketId: string) => boardTicketIds.has(ticketId),
    [boardTicketIds],
  );

  const isRefreshing = boardQuery.isFetching || statusQuery.isFetching;

  // boardQuery/statusQuery は TanStack Query v5 の trackResult が毎レンダー
  // 新しい Proxy を生成するため、オブジェクトそのものを依存配列に入れると
  // useCallback が実質メモ化されない (bdboard-t43h)。refetch 自体は
  // QueryObserver のコンストラクタで一度だけ bind される安定参照なので、
  // それを分割代入して依存させる。
  const { refetch: refetchBoard } = boardQuery;
  const { refetch: refetchStatus } = statusQuery;

  const handleRefresh = useCallback(() => {
    void refetchBoard();
    void refetchStatus();
    reconnect();
  }, [refetchBoard, refetchStatus, reconnect]);

  const handleToggleProject = useCallback((projectId: string, checked: boolean) => {
    setSelectedProjectIds((current) => {
      if (checked) {
        if (current.includes(projectId)) return current;
        return [...current, projectId];
      }
      return current.filter((id) => id !== projectId);
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    const allIds = (projectsQuery.data ?? []).map((project: ProjectDto) => project.id);
    setSelectedProjectIds(allIds);
  }, [projectsQuery.data]);

  const handleClearAll = useCallback(() => {
    setSelectedProjectIds([]);
  }, []);

  const handleOpenSessionList = useCallback((projectId?: string) => {
    setSessionListProjectId(projectId);
    setSessionListOpen(true);
  }, []);

  const handleCloseSessionList = useCallback(() => {
    setSessionListOpen(false);
    setSessionListProjectId(undefined);
  }, []);

  const handleOpenSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);

  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);

  const handleOpenShortcuts = useCallback(() => {
    setShortcutsOpen(true);
  }, []);

  const handleCloseShortcuts = useCallback(() => {
    setShortcutsOpen(false);
  }, []);

  const handleOpenHelp = useCallback(() => {
    setHelpOpen(true);
  }, []);

  const handleCloseHelp = useCallback(() => {
    setHelpOpen(false);
  }, []);

  const paletteActions = useMemo(
    () =>
      buildPaletteActions({
        onViewChange: setView,
        onOpenChat: () => setChatOpen(true),
        onToggleHideDone: () => setHideDone((current) => !current),
        hideDone,
        onToggleStalledOnly: () => setStalledOnly((current) => !current),
        stalledOnly,
        onOpenSessionList: () => handleOpenSessionList(),
        onOpenHelp: handleOpenHelp,
        onRefresh: handleRefresh,
        chatAvailable,
      }),
    [
      chatAvailable,
      handleOpenHelp,
      handleOpenSessionList,
      handleRefresh,
      hideDone,
      setHideDone,
      setStalledOnly,
      setView,
      stalledOnly,
    ],
  );

  const handleFilterByEpic = useCallback((ticketId: string) => {
    setEpicFilterId(ticketId);
    handleCloseDetail();
  }, [handleCloseDetail]);

  // bdboard-3tw.95 review (M3): switching the view synchronously inside
  // handleFilterByEpic raced with handleCloseDetail()'s window.history.back() —
  // the resulting async popstate (useTicketDeepLink's onLocationChange) restores
  // the view that was active when the ticket panel was opened, which lands
  // *after* our synchronous setView and silently overwrites it. Applying the
  // switch from an effect keyed only on epicFilterId sidesteps the race: it
  // reads `view` once, from the same render as the epicFilterId update (before
  // any popstate has had a chance to fire), and — now that the epic-filter
  // indicator/board render for 'merged' | 'split' | 'next' (bdboard-3tw.95
  // review M2) — it only needs to force a switch when the ticket was opened
  // from a non-board view (activity/digest/stats/hygiene/graph) that can't
  // show the filtered board at all.
  useEffect(() => {
    if (epicFilterId === undefined) {
      return;
    }
    if (view !== 'merged' && view !== 'split' && view !== 'next') {
      setView('merged');
    }
    // Intentionally epicFilterId-only: this must fire once per epic-filter
    // change, not on every subsequent view change (which would fight the
    // user's own navigation, e.g. from 'merged' to 'next' while the filter is
    // still active).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epicFilterId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isModifier = event.metaKey || event.ctrlKey;
      if (!isModifier || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key !== 'k' && event.key !== 'K') {
        return;
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      if (helpOpen || tunnelModalOpen) {
        return;
      }

      event.preventDefault();
      setSearchOpen(true);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [helpOpen, tunnelModalOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '?') {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      if (shortcutsOpen) {
        event.preventDefault();
        handleCloseShortcuts();
        return;
      }

      if (
        searchOpen ||
        helpOpen ||
        chatOpen ||
        sessionListOpen ||
        tunnelModalOpen ||
        selectedTicketId !== null
      ) {
        return;
      }

      event.preventDefault();
      handleOpenShortcuts();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    chatOpen,
    helpOpen,
    handleCloseShortcuts,
    handleOpenShortcuts,
    searchOpen,
    sessionListOpen,
    tunnelModalOpen,
    selectedTicketId,
    shortcutsOpen,
  ]);

  return (
    <UndoSnackbarProvider>
    <PopoverCoordinatorProvider>
    <div className="app">
      <header className="header">
        <ErrorBoundary label="ヘッダー">
        <GlobalBar
          view={view}
          onViewChange={setView}
          notificationUnreadCount={notificationEvents.unreadCount}
          onOpenSearch={handleOpenSearch}
          streamState={streamState}
          connectStalled={connectStalled}
          lastContactAtMs={lastContactAtMs}
          generatedAt={boardQuery.data?.generatedAt}
          lastRefreshAt={lastRefreshAt}
          totalSessionCount={totalSessionCount}
          activeSessionCount={activeSessionCount}
          onOpenSessionList={() => handleOpenSessionList()}
          statusDetailOpen={statusDetailOpen}
          onStatusDetailOpenChange={setStatusDetailOpen}
          projects={projectsQuery.data ?? []}
          selectedProjectIds={selectedProjectIds}
          onToggleProject={handleToggleProject}
          onSelectAllProjects={handleSelectAll}
          onClearAllProjects={handleClearAll}
          onSaveProjectCombination={() => setPresetSaveIntentToken((token) => token + 1)}
          onOpenSettings={() => setView('settings')}
          onOpenTunnel={() => setTunnelModalOpen(true)}
          onOpenHelp={handleOpenHelp}
          onOpenShortcuts={handleOpenShortcuts}
          tipsBannerDismissed={tipsBannerDismissed}
          onShowTipsBanner={() => setTipsBannerDismissed(false)}
        />
        </ErrorBoundary>

        <ErrorBoundary label="ツールバー">
        <ViewToolbar
          view={view}
          boardFilterPresets={boardFilterPresets}
          onBoardFilterPresetsChange={setBoardFilterPresets}
          boardFilterPresetState={boardFilterPresetState}
          onApplyBoardFilterPreset={handleApplyBoardFilterPreset}
          hideDone={hideDone}
          onHideDoneChange={setHideDone}
          stalledOnly={stalledOnly}
          onStalledOnlyChange={setStalledOnly}
          totalSessionCount={totalSessionCount}
          activeSessionCount={activeSessionCount}
          onOpenSessionList={() => handleOpenSessionList()}
          onRefresh={handleRefresh}
          isRefreshing={isRefreshing}
          chatAvailable={chatAvailable}
          onOpenChat={() => setChatOpen(true)}
          presetSaveIntentToken={presetSaveIntentToken}
        />
        </ErrorBoundary>
      </header>

      <AlertBar
        streamState={streamState}
        lastContactAtMs={lastContactAtMs}
        connectStalled={connectStalled}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
        onOpenDetails={() => setStatusDetailOpen(true)}
      />

      {statusErrors.length > 0 && (
        <div className="header-status-errors error-banner">
          <strong>ステータスエラー ({statusErrors.length} 件)</strong>
          <ul>
            {statusErrors.map((entry, index) => (
              <li key={`${entry.kind}-${entry.projectId}-${index}`}>
                [{entry.kind}] {entry.projectId}: {entry.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!tipsBannerDismissed && (
        <TipsBanner
          onOpenHelp={handleOpenHelp}
          onDismiss={() => setTipsBannerDismissed(true)}
        />
      )}

      <main className="main">
        {/* プロバイダーは境界の外に置く。中に入れると key={view} の再マウントが
            そのまま伝わり、ビューを往復しただけで一括選択が消える (PR#129 レビュー)。
            context を配るだけの薄い描画なので、境界で守る価値もほぼ無い。 */}
        <BoardDnDProvider>
        <BulkSelectionProvider>
        <AppViewContent
          view={view}
          filterState={boardFilterState}
          epicFilterId={epicFilterId}
          onClearEpicFilter={() => setEpicFilterId(undefined)}
          board={{
            query: boardQuery,
            cardsById: boardCardsById,
            availableLabels,
          }}
          boardMeta={{
            projectNames,
            projectActiveSessions,
            projectRootPaths,
            pendingDecisionIds,
            prLinksById,
            wipLimitsOverrides,
            selectedProjectIds,
            selectedProjectIdsJoined,
          }}
          selectedTicketId={selectedTicketId}
          onCardClick={handleSelectTicket}
          onSessionBadgeClick={handleOpenSessionList}
          nextUp={{
            limit: nextUpLimit,
            onLimitChange: setNextUpLimit,
            showEpics: nextUpShowEpics,
            onShowEpicsChange: setNextUpShowEpics,
            batchRun: nextUpBatchRun,
            harnessStatuses:
              harnessStatusQuery.data !== undefined ? harnessStatuses : undefined,
          }}
          windows={{
            activityWindowDays,
            onActivityWindowDaysChange: setActivityWindowDays,
            digestWindowDays,
            onDigestWindowDaysChange: setDigestWindowDays,
            statsWeeks,
            onStatsWeeksChange: setStatsWeeks,
          }}
          notificationEvents={notificationEvents}
        />
        </BulkSelectionProvider>
        </BoardDnDProvider>
      </main>

      <AppTicketDetailOverlay
        selectedTicketId={selectedTicketId}
        projectRootPaths={projectRootPaths}
        pendingDecision={
          selectedTicketId !== null ? pendingDecisionsById.get(selectedTicketId) : undefined
        }
        prLink={selectedTicketId !== null ? prLinksById.get(selectedTicketId) : undefined}
        onClose={handleCloseDetail}
        onChatAboutTicket={
          chatAvailable
            ? (context) => {
                setChatContext(context);
                setChatContextToken((token) => token + 1);
                setChatOpen(true);
              }
            : undefined
        }
        onOpenTicket={handleSelectTicket}
        onBackTicket={canGoBackTicket ? goBackTicket : undefined}
        isMaximized={detailMaximized}
        onToggleMaximized={handleToggleDetailMaximized}
        isTicketOnBoard={isTicketOnBoard}
        onFilterByEpic={handleFilterByEpic}
        onTicketViewed={handleRecordRecentTicket}
        availableLabels={availableLabels ?? []}
      />

      <AppSessionListOverlay
        open={sessionListOpen}
        projectId={sessionListProjectId}
        onClose={handleCloseSessionList}
      />

      <AppShortcutsOverlay open={shortcutsOpen} onClose={handleCloseShortcuts} />

      <AppHelpOverlay open={helpOpen} onClose={handleCloseHelp} />

      <AppSearchOverlay
        open={searchOpen}
        onClose={handleCloseSearch}
        onSelect={handleSelectTicket}
        actions={paletteActions}
        recentTickets={recentTickets}
      />

      <AppTunnelOverlay open={tunnelModalOpen} onClose={() => setTunnelModalOpen(false)} />

      <AppChatOverlay
        open={chatOpen}
        projects={chatProjects}
        initialProjectId={
          chatContext?.projectId ??
          (selectedProjectIds.length === 1
            ? selectedProjectIds[0]
            : lastChatProjectId !== ''
              ? lastChatProjectId
              : undefined)
        }
        initialInput={
          chatContext === undefined ? undefined : `${chatContext.ticketId} について: `
        }
        ticketContextToken={chatContext === undefined ? undefined : chatContextToken}
        onProjectIdChange={setLastChatProjectId}
        isTicketOnBoard={isTicketOnBoard}
        onOpenTicket={handleSelectTicket}
        onClose={() => {
          setChatOpen(false);
          setChatContext(undefined);
        }}
      />

    </div>
    </PopoverCoordinatorProvider>
    </UndoSnackbarProvider>
  );
}
