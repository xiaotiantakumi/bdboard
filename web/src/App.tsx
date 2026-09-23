import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectDto } from './api';
import { BoardDnDProvider } from './components/BoardDnDProvider';
import { BulkSelectionProvider } from './components/BulkSelectionProvider';
import { UndoSnackbarProvider } from './components/UndoSnackbar';
import { PopoverCoordinatorProvider } from './components/PopoverCoordinator';
import { AlertBar } from './components/AlertBar';
import {
  createTicketRunsInvalidator,
  useNextUpRunLoopController,
} from './components/nextUpRunLoop';
import { TipsBanner } from './components/TipsBanner';
import { useWatchedTickets } from './components/WatchedTicketsProvider';
import { AppOverlayGroup } from './components/app/AppOverlayGroup';
import { AppViewContent } from './components/app/AppViewContent';
import { AppHeader } from './components/app/AppHeader';
import { useHeaderHeightVar } from './hooks/useHeaderHeightVar';
import { useNotificationEvents } from './hooks/useNotificationEvents';
import { useWatchedTicketDetails } from './hooks/useWatchedTicketDetails';
import { usePersistedState } from './hooks/usePersistedState';
import { useBoardFilterState } from './hooks/useBoardFilterState';
import { useTicketDeepLink } from './hooks/useTicketDeepLink';
import { useAppOverlays } from './hooks/useAppOverlays';
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts';
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
   * 詳細パネルの最大化 (bdboard-0hcx) とオーバーレイ/パネルの開閉状態
   * (検索・ショートカット一覧・ヘルプ・チャット・セッション一覧・トンネル・
   * ステータス詳細・プリセット保存意図トークン) は useAppOverlays.ts に
   * まとめた (bdboard-62p4 第4段)。ここでの呼び出し位置は元の状態群の
   * 先頭 (旧 L191、detailMaximized の useState) と同じ — useTicketDeepLink
   * の直後・データ取得9系統より前 — なので、内部の useState 群と
   * detailMaximized の useEffect は元と同じ相対位置で登録される。
   * 各ハンドラの前倒し理由・依存配列の扱いは useAppOverlays.ts の JSDoc を
   * 参照。
   */
  const overlays = useAppOverlays(selectedTicketId);
  // 初回起動判定は localStorage が書き戻される前(= 最初のレンダー中)に確定させる。
  const [hadStoredFilterStateAtStartup] = useState(() => hasStoredBoardFilterState());
  const defaultPresetHandledRef = useRef(false);

  const selectedProjectIdsJoined = selectedProjectIds.join(',');
  const boardApiMode = boardApiModeFromView(view);

  /*
   * bdboard-62p4 PR-3 レビュー対応: この2つ (boardFilterPresetState /
   * handleApplyBoardFilterPreset) と「既定」プリセット自動適用 effect は、
   * 元の App.tsx では下のデータ取得9系統より後ろで宣言されていたが、
   * 依存先 (view/selectedProjectIds/boardFilterState 由来の値・setView・
   * setSelectedProjectIds) はすべてこれより前で定義済みでデータ取得9系統には
   * 依存しない。一方で useProjectsData 内のプロジェクト絞り込み sanitize
   * effect は projectsQuery.data に依存し、元のコードでは「既定プリセット
   * 適用 effect」→「sanitize effect」の順で実行されていた (同一コミット内で
   * setSelectedProjectIds が2回連続で呼ばれる際の実行順)。抽出後にこの並びを
   * そのまま (データ取得9系統を先に呼ぶ) にすると、初回マウント時に
   * projectsQuery のデータが既にキャッシュ済みだと sanitize が先に走り、
   * 既定プリセットが上書きするはずのサニタイズ結果を今度はプリセット適用が
   * 上書きしてしまう逆転が起きる。それを避けるため、この3つを元の相対順序
   * (プリセット適用 effect が先、sanitize effect が後) を保つようデータ
   * 取得9系統より前に前倒しした。
   */
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

  /*
   * データ取得 9 系統 (bdboard-62p4 PR-3)。元は9つの useQuery とそこから導く
   * useMemo/useEffect がすべて App 本体にフラットに並んでいたが、関心ごとの
   * カスタムフック (web/src/hooks/useXxxData.ts) へ抽出した。各フックの
   * queryKey/queryFn/enabled/retry と派生 useMemo の依存配列・本体は元の
   * App.tsx から1文字も変えていない — 詳細は各フックの JSDoc と PR 本文の
   * 対照表を参照。9系統どうしの呼び出し順は元の宣言順 (projects → sessions →
   * status → board → useLastServerContact → pendingDecisions → prLinks →
   * chatAvailability → boardThresholds → harnessStatus) をそのまま維持して
   * いる。useAppBadge の呼び出し位置だけ pendingDecisions 側へ前倒しした
   * 理由は usePendingDecisionsData.ts の JSDoc を参照。boardFilterPresetState/
   * handleApplyBoardFilterPreset/既定プリセット適用 effect がこの9系統より
   * 前に来ている理由は直前のコメントを参照 (sanitize effect との相対順序を
   * 保つための前倒し)。
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

  // overlays.handleOpenChat/handleOpenHelp/handleOpenSessionList を
  // useMemo の外で分割代入しておく。クロージャ内で `overlays.x` の形のまま
  // 参照すると react-hooks/exhaustive-deps が `overlays` オブジェクト全体
  // (毎レンダー新しい参照) を依存に要求し、paletteActions が毎レンダー
  // 再計算されてしまう (useAppOverlays の各ハンドラ自体は useCallback で
  // 安定しているので、分割代入した個別の関数を依存に使えば元と同じ
  // メモ化粒度を保てる)。
  const { handleOpenChat, handleOpenHelp, handleOpenSessionList } = overlays;

  const paletteActions = useMemo(
    () =>
      buildPaletteActions({
        onViewChange: setView,
        onOpenChat: handleOpenChat,
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
      handleOpenChat,
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

  // bdboard-62p4 第4段: グローバルキーボードショートカット2本
  // (Cmd/Ctrl+K・`?`) は useAppKeyboardShortcuts.ts にまとめた。呼び出し位置は
  // 元の2つの effect があった場所 (epicFilterId 切り替え effect の直後) と
  // 同じなので、この2つの useEffect は元と同じ相対順序で登録される。
  useAppKeyboardShortcuts({
    helpOpen: overlays.helpOpen,
    tunnelModalOpen: overlays.tunnelModalOpen,
    chatOpen: overlays.chatOpen,
    searchOpen: overlays.searchOpen,
    sessionListOpen: overlays.sessionListOpen,
    shortcutsOpen: overlays.shortcutsOpen,
    selectedTicketId,
    onOpenSearch: overlays.handleOpenSearch,
    onOpenShortcuts: overlays.handleOpenShortcuts,
    onCloseShortcuts: overlays.handleCloseShortcuts,
  });

  return (
    <UndoSnackbarProvider>
    <PopoverCoordinatorProvider>
    <div className="app">
      <AppHeader
        view={view}
        onViewChange={setView}
        notificationUnreadCount={notificationEvents.unreadCount}
        onOpenSearch={overlays.handleOpenSearch}
        connection={{
          streamState,
          connectStalled,
          lastContactAtMs,
          generatedAt: boardQuery.data?.generatedAt,
          lastRefreshAt,
        }}
        sessions={{
          total: totalSessionCount,
          active: activeSessionCount,
          onOpen: overlays.handleOpenSessionList,
        }}
        statusDetail={{
          open: overlays.statusDetailOpen,
          onOpenChange: overlays.setStatusDetailOpen,
        }}
        projects={{
          list: projectsQuery.data ?? [],
          selectedIds: selectedProjectIds,
          onToggle: handleToggleProject,
          onSelectAll: handleSelectAll,
          onClearAll: handleClearAll,
          onSaveCombination: overlays.handleSaveProjectCombination,
        }}
        onOpenSettings={() => setView('settings')}
        onOpenTunnel={overlays.handleOpenTunnel}
        onOpenHelp={overlays.handleOpenHelp}
        onOpenShortcuts={overlays.handleOpenShortcuts}
        tipsBanner={{
          dismissed: tipsBannerDismissed,
          onShow: () => setTipsBannerDismissed(false),
        }}
        toolbar={{
          boardFilterPresets,
          onBoardFilterPresetsChange: setBoardFilterPresets,
          boardFilterPresetState,
          onApplyBoardFilterPreset: handleApplyBoardFilterPreset,
          hideDone,
          onHideDoneChange: setHideDone,
          stalledOnly,
          onStalledOnlyChange: setStalledOnly,
          onRefresh: handleRefresh,
          isRefreshing,
          chatAvailable,
          onOpenChat: overlays.handleOpenChat,
          presetSaveIntentToken: overlays.presetSaveIntentToken,
        }}
      />

      <AlertBar
        streamState={streamState}
        lastContactAtMs={lastContactAtMs}
        connectStalled={connectStalled}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
        onOpenDetails={overlays.handleOpenStatusDetail}
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
          onOpenHelp={overlays.handleOpenHelp}
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
          onSessionBadgeClick={overlays.handleOpenSessionList}
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

      <AppOverlayGroup
        ticketDetail={{
          selectedTicketId,
          projectRootPaths,
          pendingDecision:
            selectedTicketId !== null ? pendingDecisionsById.get(selectedTicketId) : undefined,
          prLink: selectedTicketId !== null ? prLinksById.get(selectedTicketId) : undefined,
          onClose: handleCloseDetail,
          onChatAboutTicket: chatAvailable ? overlays.handleChatAboutTicket : undefined,
          onOpenTicket: handleSelectTicket,
          onBackTicket: canGoBackTicket ? goBackTicket : undefined,
          isMaximized: overlays.detailMaximized,
          onToggleMaximized: overlays.handleToggleDetailMaximized,
          isTicketOnBoard,
          onFilterByEpic: handleFilterByEpic,
          onTicketViewed: handleRecordRecentTicket,
          availableLabels: availableLabels ?? [],
        }}
        sessionList={{
          open: overlays.sessionListOpen,
          projectId: overlays.sessionListProjectId,
          onClose: overlays.handleCloseSessionList,
        }}
        shortcuts={{ open: overlays.shortcutsOpen, onClose: overlays.handleCloseShortcuts }}
        help={{ open: overlays.helpOpen, onClose: overlays.handleCloseHelp }}
        search={{
          open: overlays.searchOpen,
          onClose: overlays.handleCloseSearch,
          onSelect: handleSelectTicket,
          actions: paletteActions,
          recentTickets,
        }}
        tunnel={{ open: overlays.tunnelModalOpen, onClose: overlays.handleCloseTunnel }}
        chat={{
          open: overlays.chatOpen,
          projects: chatProjects,
          initialProjectId:
            overlays.chatContext?.projectId ??
            (selectedProjectIds.length === 1
              ? selectedProjectIds[0]
              : lastChatProjectId !== ''
                ? lastChatProjectId
                : undefined),
          initialInput:
            overlays.chatContext === undefined
              ? undefined
              : `${overlays.chatContext.ticketId} について: `,
          ticketContextToken:
            overlays.chatContext === undefined ? undefined : overlays.chatContextToken,
          onProjectIdChange: setLastChatProjectId,
          isTicketOnBoard,
          onOpenTicket: handleSelectTicket,
          onClose: overlays.handleCloseChat,
        }}
      />

    </div>
    </PopoverCoordinatorProvider>
    </UndoSnackbarProvider>
  );
}
