import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { useAppFilterPresets } from './hooks/useAppFilterPresets';
import { useAppActions } from './hooks/useAppActions';
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
  validateRecentTickets,
  DEFAULT_TIPS_BANNER_DISMISSED,
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

  const selectedProjectIdsJoined = selectedProjectIds.join(',');
  const boardApiMode = boardApiModeFromView(view);

  // bdboard-62p4 第5段: boardFilterPresetState(現在の絞り込み状態の
  // スナップショット)・handleApplyBoardFilterPreset・初回起動時の「既定」
  // プリセット自動適用 effect は useAppFilterPresets.ts にまとめた。呼び出し
  // 位置は元の3つ(+内部で使う useState/useRef)があった場所(useAppOverlays の
  // 直後・データ取得9系統より前)と同じなので、内部の
  // useState/useRef/useMemo/useCallback/useEffect は App.tsx 全体で見ても
  // 元と同じ相対順序で登録される。この位置である理由(useProjectsData の
  // sanitize effect との相対実行順序)は useAppFilterPresets.ts の JSDoc を
  // 参照。
  const { boardFilterPresetState, handleApplyBoardFilterPreset } = useAppFilterPresets({
    view,
    selectedProjectIds,
    priorityCeiling: boardPriorityCeiling,
    issueTypes: boardIssueTypes,
    labels: boardLabels,
    filterText: boardFilterText,
    hideDone,
    stalledOnly,
    setView,
    setSelectedProjectIds,
    setPriorityCeiling: setBoardPriorityCeiling,
    setIssueTypes: setBoardIssueTypes,
    setLabels: setBoardLabels,
    setFilterText: setBoardFilterText,
    setHideDone,
    setStalledOnly,
    boardFilterPresets,
  });

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
   * 前に来ている理由は useAppFilterPresets.ts の JSDoc を参照 (sanitize
   * effect との相対順序を保つための前倒し)。
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

  // bdboard-62p4 第5段: 最近開いたチケット記録・ボード在籍判定・手動
  // リフレッシュ・プロジェクト選択・コマンドパレット・エピック絞り込みの
  // ハンドラ群は useAppActions.ts にまとめた。呼び出し位置は元の並び(データ
  // 取得9系統 + ウォッチ関連の直後、useAppKeyboardShortcuts の直前)と同じ
  // なので、内部の useCallback(7個)/useMemo(1個)/useEffect(1個、
  // epicFilterId 切り替え)は App.tsx 全体で見ても元と同じ相対順序で登録
  // される。詳細は useAppActions.ts の JSDoc を参照。
  const {
    handleRecordRecentTicket,
    isTicketOnBoard,
    isRefreshing,
    handleRefresh,
    handleToggleProject,
    handleSelectAll,
    handleClearAll,
    paletteActions,
    handleFilterByEpic,
  } = useAppActions({
    setRecentTickets,
    projectNames,
    boardTicketIds,
    boardQuery,
    statusQuery,
    reconnect,
    setSelectedProjectIds,
    projectsQuery,
    setView,
    handleOpenChat: overlays.handleOpenChat,
    setHideDone,
    hideDone,
    setStalledOnly,
    stalledOnly,
    handleOpenSessionList: overlays.handleOpenSessionList,
    handleOpenHelp: overlays.handleOpenHelp,
    chatAvailable,
    setEpicFilterId,
    handleCloseDetail,
    epicFilterId,
    view,
  });

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
