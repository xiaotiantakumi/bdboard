import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAllHarnessStatus,
  fetchBoard,
  fetchBoardThresholdsConfig,
  fetchChatAvailability,
  fetchPendingDecisions,
  fetchPrLinks,
  fetchProjects,
  fetchSessions,
  fetchStatus,
  type BoardCardDto,
  type Lane,
  type PendingDecisionDto,
  type PrBadgeDto,
  type ProjectDto,
  type ProjectHarnessStatusDto,
} from './api';
import { setBoardTimeZoneOverride } from './boardTimeZone';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BoardLanes, hasVisibleCards, SplitBoard } from './components/BoardView';
import { BoardFilterBar } from './components/BoardFilterBar';
import { BoardDnDProvider } from './components/BoardDnDProvider';
import { BulkActionBar } from './components/BulkActionBar';
import { BulkSelectionProvider } from './components/BulkSelectionProvider';
import { UndoSnackbarProvider } from './components/UndoSnackbar';
import { PopoverCoordinatorProvider } from './components/PopoverCoordinator';
import { ActivityFeed } from './components/ActivityFeed';
import { DailyDigest } from './components/DailyDigest';
import { AlertBar } from './components/AlertBar';
import { GlobalBar } from './components/GlobalBar';
import { ViewToolbar } from './components/ViewToolbar';
import { ChatPanel } from './components/ChatPanel';
import { DependencyGraphView } from './components/DependencyGraphView';
import { HygienePanel } from './components/HygienePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { EventCenterPanel } from './components/EventCenterPanel';
import { NextUpView } from './components/NextUpView';
import { useNextUpRunLoopController } from './components/nextUpRunLoop';
import { ThroughputStats } from './components/ThroughputStats';
import { KeyboardShortcutsPanel } from './components/KeyboardShortcutsPanel';
import { HelpPanel } from './components/HelpPanel';
import { TipsBanner } from './components/TipsBanner';
import { SearchPalette } from './components/SearchPalette';
import { SessionListPanel } from './components/SessionListPanel';
import { TicketDetailPanel } from './components/TicketDetailPanel';
import { TunnelControl } from './components/TunnelControl';
import { useWatchedTickets } from './components/WatchedTicketsProvider';
import { isBoardFilterActive } from './boardFilter';
import type { WipLimitsOverrides } from './wip-limits';
import { useAppBadge } from './hooks/useAppBadge';
import { useHeaderHeightVar } from './hooks/useHeaderHeightVar';
import { useNotificationEvents } from './hooks/useNotificationEvents';
import { useWatchedTicketDetails } from './hooks/useWatchedTicketDetails';
import { usePersistedState } from './hooks/usePersistedState';
import { useTicketDeepLink } from './hooks/useTicketDeepLink';
import {
  boardApiModeFromView,
  DEFAULT_VIEW,
  sanitizeProjectFilter,
  UI_STORAGE_KEYS,
  validateActivityWindowDays,
  validateBoolean,
  validateNextUpLimit,
  validateStatsWeeks,
  validateString,
  validateStringArray,
  validateViewMode,
  validatePriorityCeiling,
  priorityCeilingValue,
  validateIssueTypeArray,
  validateLaneArray,
  validateBoardFilterPresets,
  findDefaultBoardFilterPreset,
  hasStoredBoardFilterState,
  validateRecentTickets,
  recordRecentTicket,
  DEFAULT_HIDE_DONE,
  DEFAULT_STALLED_ONLY,
  type BoardFilterPreset,
  type BoardFilterPresetState,
} from './uiPersistedState';
import { useLastServerContact } from './hooks/useLastServerContact';
import {
  collectBoardCardsById,
  collectBoardLabels,
  collectBoardTicketIds,
} from './boardTicketIds';
import { buildPaletteActions, VIEW_LABELS } from './paletteActions';
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
  const [hideDone, setHideDone] = usePersistedState(
    UI_STORAGE_KEYS.hideDone,
    DEFAULT_HIDE_DONE,
    validateBoolean,
  );
  const [stalledOnly, setStalledOnly] = usePersistedState(
    UI_STORAGE_KEYS.stalledOnly,
    DEFAULT_STALLED_ONLY,
    validateBoolean,
  );
  const [collapsedLanes, setCollapsedLanes] = usePersistedState(
    UI_STORAGE_KEYS.collapsedLanes,
    [],
    validateLaneArray,
  );
  const [boardPriorityCeiling, setBoardPriorityCeiling] = usePersistedState(
    UI_STORAGE_KEYS.boardPriorityCeiling,
    'all',
    validatePriorityCeiling,
  );
  const [boardIssueTypes, setBoardIssueTypes] = usePersistedState(
    UI_STORAGE_KEYS.boardIssueTypes,
    [],
    validateIssueTypeArray,
  );
  const [boardLabels, setBoardLabels] = usePersistedState(
    UI_STORAGE_KEYS.boardLabels,
    [],
    validateStringArray,
  );
  const [boardFilterText, setBoardFilterText] = usePersistedState(
    UI_STORAGE_KEYS.boardFilterText,
    '',
    validateString,
  );
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
  const nextUpBatchRun = useNextUpRunLoopController();
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
   * 下の ErrorBoundary が key={selectedTicketId} を持つため、パネル側で
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

  const queryClient = useQueryClient();

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  });

  // N7: `projectsQuery.data ?? []` builds a fresh array literal on every
  // render while the query is still loading. ChatPanel's ticket-context
  // effect (bdboard-3tw.104.14 S1) depends on `projects` to re-evaluate once
  // the list arrives, so an unstable reference here would make that effect
  // re-run on every unrelated App re-render in the meantime. Memoize a
  // stable fallback so it only changes when the query data actually does.
  const chatProjects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);

  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
  });

  const statusQuery = useQuery({
    queryKey: ['status'],
    queryFn: fetchStatus,
  });

  useEffect(() => {
    setBoardTimeZoneOverride(statusQuery.data?.boardTimeZone);
  }, [statusQuery.data?.boardTimeZone]);

  const boardQuery = useQuery({
    queryKey: ['board', boardApiMode, selectedProjectIdsJoined, epicFilterId],
    queryFn: () =>
      fetchBoard({
        projectIds: selectedProjectIds,
        view: boardApiMode,
        ...(epicFilterId !== undefined ? { epicId: epicFilterId } : {}),
      }),
  });

  const { streamState, lastContactAtMs, reconnect, connectStalled } = useLastServerContact(boardQuery.dataUpdatedAt);

  const pendingDecisionsQuery = useQuery({
    queryKey: ['pending-decisions'],
    queryFn: fetchPendingDecisions,
  });

  const prLinksQuery = useQuery({
    queryKey: ['pr-links', selectedProjectIdsJoined],
    queryFn: () => fetchPrLinks(selectedProjectIds),
    retry: false,
  });

  // PR バッジ用スキャンが close 証拠の唯一の走査元になったため、これが完了しても
  // hygiene 側からは分からない。手動で invalidate しないと、静かなボードでは初回表示が
  // 全件 unknown のまま SSE イベントまで解消しない (bdboard-pkr6.16 レビュー対応, m3)。
  useEffect(() => {
    if (prLinksQuery.dataUpdatedAt > 0) {
      void queryClient.invalidateQueries({ queryKey: ['hygiene'] });
    }
  }, [prLinksQuery.dataUpdatedAt, queryClient]);

  useAppBadge(pendingDecisionsQuery.data?.length);

  const chatAvailabilityQuery = useQuery({
    queryKey: ['chat-availability'],
    queryFn: fetchChatAvailability,
    retry: false,
  });

  const boardThresholdsQuery = useQuery({
    queryKey: ['board-thresholds-config'],
    queryFn: fetchBoardThresholdsConfig,
    retry: false,
  });

  /*
   * 一括実行の前提判定 (bdboard-pkr6.11) 用。Next Up を見ているときだけ引く
   * — 判定に使うのはそのビューのボタンだけで、他のビューでは注入先の
   * `.claude/` を読ませる理由が無い。取得できなくても「不明」として扱い、
   * ボタンは殺さない (最終判定はサーバーの preflight)。
   */
  const harnessStatusQuery = useQuery({
    queryKey: ['harness-status-all'],
    queryFn: fetchAllHarnessStatus,
    enabled: view === 'next',
    retry: false,
  });

  const harnessStatuses = useMemo(() => {
    const map = new Map<string, ProjectHarnessStatusDto>();
    for (const entry of harnessStatusQuery.data?.projects ?? []) {
      map.set(entry.projectId, { packs: entry.packs, contract: entry.contract });
    }
    return map;
  }, [harnessStatusQuery.data]);

  const wipLimitsOverrides = useMemo((): WipLimitsOverrides => {
    const config = boardThresholdsQuery.data;
    if (config === undefined) {
      return {};
    }
    return {
      ...(config.inProgressWipLimit !== null
        ? { inProgressWipLimit: config.inProgressWipLimit }
        : {}),
      inProgressWipLimitByProject: config.inProgressWipLimitByProject,
    };
  }, [boardThresholdsQuery.data]);

  // 'unknown'(認証未確認) でもチャット自体は開かせる。開けなくすると
  // 「判定できていないだけ」を「使えない」と扱う別種の嘘になる。
  const chatAvailable =
    chatAvailabilityQuery.data !== undefined &&
    chatAvailabilityQuery.data.availability !== 'unavailable';

  const pendingDecisionsById = useMemo(() => {
    const map = new Map<string, PendingDecisionDto>();
    for (const decision of pendingDecisionsQuery.data ?? []) {
      map.set(decision.id, decision);
    }
    return map;
  }, [pendingDecisionsQuery.data]);

  const pendingDecisionIds = useMemo(() => {
    return new Set(pendingDecisionsById.keys());
  }, [pendingDecisionsById]);

  const prLinksById = useMemo(() => {
    const map = new Map<string, PrBadgeDto>();
    for (const badge of prLinksQuery.data ?? []) {
      map.set(badge.ticketId, badge);
    }
    return map;
  }, [prLinksQuery.data]);

  const collapsedLanesSet = useMemo(
    () => new Set<Lane>(collapsedLanes),
    [collapsedLanes],
  );

  const handleToggleLaneCollapse = useCallback(
    (lane: Lane) => {
      setCollapsedLanes((prev) =>
        prev.includes(lane) ? prev.filter((item) => item !== lane) : [...prev, lane],
      );
    },
    [setCollapsedLanes],
  );

  const boardFilter = useMemo(
    () => ({
      priorityCeiling: priorityCeilingValue(boardPriorityCeiling),
      issueTypes: boardIssueTypes,
      labels: boardLabels,
      text: boardFilterText,
    }),
    [boardPriorityCeiling, boardIssueTypes, boardLabels, boardFilterText],
  );

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

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projectsQuery.data ?? []) {
      map.set(project.id, project.name);
    }
    return map;
  }, [projectsQuery.data]);

  const projectActiveSessions = useMemo(() => {
    const map = new Map<string, number>();
    for (const project of projectsQuery.data ?? []) {
      map.set(project.id, project.activeSessionCount);
    }
    return map;
  }, [projectsQuery.data]);

  useEffect(() => {
    const projects = projectsQuery.data;
    if (projects === undefined) {
      return;
    }
    const availableProjectIds = projects.map((project) => project.id);
    setSelectedProjectIds((current) =>
      sanitizeProjectFilter(current, availableProjectIds),
    );
  }, [projectsQuery.data, setSelectedProjectIds]);

  const boardTicketIds = useMemo(() => {
    const ids = new Set<string>();
    const data = boardQuery.data;
    if (data === undefined) {
      return ids;
    }
    if (data.merged !== null) {
      collectBoardTicketIds(data.merged, ids);
    }
    for (const entry of data.projects) {
      collectBoardTicketIds(entry.board, ids);
    }
    return ids;
  }, [boardQuery.data]);

  const availableLabels = useMemo(() => {
    const labels = new Set<string>();
    const data = boardQuery.data;
    if (data === undefined) {
      return [];
    }
    if (data.merged !== null) {
      collectBoardLabels(data.merged, labels);
    }
    for (const entry of data.projects) {
      collectBoardLabels(entry.board, labels);
    }
    return [...labels].sort();
  }, [boardQuery.data]);

  const boardCardsById = useMemo(() => {
    const map = new Map<string, BoardCardDto>();
    const data = boardQuery.data;
    if (data === undefined) {
      return map;
    }
    if (data.merged !== null) {
      collectBoardCardsById(data.merged, map);
    }
    for (const entry of data.projects) {
      collectBoardCardsById(entry.board, map);
    }
    return map;
  }, [boardQuery.data]);

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

  const projectRootPaths = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projectsQuery.data ?? []) {
      map.set(project.id, project.rootPath);
    }
    return map;
  }, [projectsQuery.data]);

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

  const totalSessionCount = (sessionsQuery.data ?? []).length;
  const activeSessionCount = (sessionsQuery.data ?? []).filter(
    (session) => session.liveness === 'active',
  ).length;

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
        onRefresh: handleRefresh,
        chatAvailable,
      }),
    [
      chatAvailable,
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

  const lastRefreshAt = statusQuery.data?.lastRefreshAt;
  const statusErrors = statusQuery.data?.errors ?? [];

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

      <TipsBanner onOpenHelp={handleOpenHelp} />

      <main className="main">
        {/* プロバイダーは境界の外に置く。中に入れると key={view} の再マウントが
            そのまま伝わり、ビューを往復しただけで一括選択が消える (PR#129 レビュー)。
            context を配るだけの薄い描画なので、境界で守る価値もほぼ無い。 */}
        <BoardDnDProvider>
        <BulkSelectionProvider>
        {/* view をキーにして、別ビューへ切り替えたら壊れた状態を持ち越さない。 */}
        <ErrorBoundary key={view} label={VIEW_LABELS[view]}>
        {(view === 'merged' || view === 'split') && (
          <BoardFilterBar
            priorityCeiling={boardPriorityCeiling}
            onPriorityCeilingChange={setBoardPriorityCeiling}
            issueTypes={boardIssueTypes}
            onIssueTypesChange={setBoardIssueTypes}
            labels={boardLabels}
            onLabelsChange={setBoardLabels}
            availableLabels={availableLabels}
            filterText={boardFilterText}
            onFilterTextChange={setBoardFilterText}
          />
        )}
        {(view === 'merged' || view === 'split' || view === 'next') &&
          epicFilterId !== undefined && (
            <div className="filter-bar-epic-indicator">
              <span>エピック {epicFilterId} のみ表示中</span>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setEpicFilterId(undefined)}
              >
                クリア
              </button>
            </div>
          )}
        {(view === 'merged' || view === 'split' || view === 'next') && boardQuery.isLoading && (
          <p className="loading">読み込み中…</p>
        )}
        {(view === 'merged' || view === 'split' || view === 'next') && boardQuery.error !== null && (
          <p className="error-message">
            {boardQuery.error instanceof Error
              ? boardQuery.error.message
              : 'ボードの読み込みに失敗しました'}
          </p>
        )}
        {/* Next Up も対象に含める (bdboard-ml0k)。BulkSelectionProvider は
            ErrorBoundary の外に置いてビュー横断で選択を保つ設計 (PR#129) で、
            Next Up のカードも LaneColumn の CardItem を再利用しているため
            チェックボックスは出るし選択も入る。ここで操作バーだけを出さないと
            「選べるのに何もできない」状態になる。Next Up が並べるのは
            board.lanes.ready のカードだけで、cardsById は merged と全
            projects から集めているので、表示中のカードは必ず含まれる。 */}
        {(view === 'merged' || view === 'split' || view === 'next') && (
          <BulkActionBar
            cardsById={boardCardsById}
            availableLabels={availableLabels}
          />
        )}
        {boardQuery.data !== undefined && view === 'merged' && boardQuery.data.merged !== null && (
          (stalledOnly || isBoardFilterActive(boardFilter)) &&
          !hasVisibleCards(
            boardQuery.data.merged,
            hideDone,
            stalledOnly,
            boardFilter,
          ) ? (
            <p className="empty-message">
              {isBoardFilterActive(boardFilter)
                ? '表示できるチケットがありません'
                : stalledOnly
                  ? '滞留しているチケットはありません'
                  : hideDone
                    ? '表示できるチケットがありません(doneレーンは非表示中です)'
                    : '表示できるチケットがありません'}
            </p>
          ) : (
            <BoardLanes
              board={boardQuery.data.merged}
              hideDone={hideDone}
              stalledOnly={stalledOnly}
              filter={boardFilter}
              showProjectName
              projectNames={projectNames}
              projectActiveSessions={projectActiveSessions}
              pendingDecisionIds={pendingDecisionIds}
              prLinksById={prLinksById}
              sectionKey={`merged-${selectedProjectIdsJoined}`}
              onCardClick={handleSelectTicket}
              collapsedLanes={collapsedLanesSet}
              onToggleLaneCollapse={handleToggleLaneCollapse}
              wipLimitsOverrides={wipLimitsOverrides}
            />
          )
        )}
        {boardQuery.data !== undefined && view === 'split' && (
          <SplitBoard
            projects={boardQuery.data.projects}
            hideDone={hideDone}
            stalledOnly={stalledOnly}
            filter={boardFilter}
            pendingDecisionIds={pendingDecisionIds}
            prLinksById={prLinksById}
            sectionKeyPrefix={selectedProjectIdsJoined}
            onCardClick={handleSelectTicket}
            onSessionBadgeClick={handleOpenSessionList}
            collapsedLanes={collapsedLanesSet}
            onToggleLaneCollapse={handleToggleLaneCollapse}
            wipLimitsOverrides={wipLimitsOverrides}
          />
        )}
        {boardQuery.data !== undefined && view === 'next' && boardQuery.data.merged !== null && (
          <NextUpView
            board={boardQuery.data.merged}
            limit={nextUpLimit}
            onLimitChange={setNextUpLimit}
            showEpics={nextUpShowEpics}
            onShowEpicsChange={setNextUpShowEpics}
            projectNames={projectNames}
            projectActiveSessions={projectActiveSessions}
            pendingDecisionIds={pendingDecisionIds}
            prLinksById={prLinksById}
            onCardClick={handleSelectTicket}
            batchRun={nextUpBatchRun}
            harnessStatuses={
              harnessStatusQuery.data !== undefined ? harnessStatuses : undefined
            }
          />
        )}
        {view === 'activity' && (
          <ActivityFeed
            projectIds={selectedProjectIds}
            windowDays={activityWindowDays}
            onWindowDaysChange={setActivityWindowDays}
            onSelectTicket={handleSelectTicket}
          />
        )}
        {view === 'digest' && (
          <DailyDigest
            projectIds={selectedProjectIds}
            windowDays={digestWindowDays}
            onWindowDaysChange={setDigestWindowDays}
          />
        )}
        {view === 'stats' && (
          <ThroughputStats
            projectIds={selectedProjectIds}
            weeks={statsWeeks}
            onWeeksChange={setStatsWeeks}
          />
        )}
        {view === 'hygiene' && (
          <HygienePanel
            projectIds={selectedProjectIds}
            onSelectTicket={handleSelectTicket}
            projectRootPaths={projectRootPaths}
          />
        )}
        {view === 'graph' && (
          <DependencyGraphView
            projectIds={selectedProjectIds}
            focusTicketId={selectedTicketId ?? undefined}
            onCardClick={handleSelectTicket}
          />
        )}
        {view === 'settings' && <SettingsPanel />}
        {view === 'events' && <EventCenterPanel {...notificationEvents} />}
        {boardQuery.data !== undefined &&
          (view === 'merged' || view === 'next') &&
          boardQuery.data.merged === null && (
            <p className="empty-message">統合ビューのデータがありません</p>
          )}
        </ErrorBoundary>
        </BulkSelectionProvider>
        </BoardDnDProvider>
      </main>

      {selectedTicketId !== null && (
        <ErrorBoundary
          key={selectedTicketId}
          label="チケット詳細"
          resetLabel="閉じる"
          onReset={handleCloseDetail}
          overlay
        >
        <TicketDetailPanel
          ticketId={selectedTicketId}
          projectRootPaths={projectRootPaths}
          pendingDecision={pendingDecisionsById.get(selectedTicketId)}
          prLink={prLinksById.get(selectedTicketId)}
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
          availableLabels={availableLabels}
        />
        </ErrorBoundary>
      )}

      {sessionListOpen && (
        <ErrorBoundary
          label="セッション一覧"
          resetLabel="閉じる"
          onReset={handleCloseSessionList}
          overlay
        >
          <SessionListPanel
            projectId={sessionListProjectId}
            onClose={handleCloseSessionList}
          />
        </ErrorBoundary>
      )}

      {shortcutsOpen && (
        <ErrorBoundary
          label="ショートカット一覧"
          resetLabel="閉じる"
          onReset={handleCloseShortcuts}
          overlay
        >
          <KeyboardShortcutsPanel onClose={handleCloseShortcuts} />
        </ErrorBoundary>
      )}

      {helpOpen && (
        <ErrorBoundary label="ヘルプ" resetLabel="閉じる" onReset={handleCloseHelp} overlay>
          <HelpPanel onClose={handleCloseHelp} />
        </ErrorBoundary>
      )}

      {searchOpen && (
        <ErrorBoundary label="検索" resetLabel="閉じる" onReset={handleCloseSearch} overlay>
        <SearchPalette
          onClose={handleCloseSearch}
          onSelect={handleSelectTicket}
          actions={paletteActions}
          recentTickets={recentTickets}
        />
        </ErrorBoundary>
      )}

      {/* TunnelControl は閉じていても常時マウントされている (中で null を返す)。
          閉じている間の throw まで overlay で覆うと、何も開いていないのに暗幕が
          残って操作不能になるので、overlay は開いているときだけ。 */}
      <ErrorBoundary
        label="トンネル"
        resetLabel="閉じる"
        onReset={() => setTunnelModalOpen(false)}
        overlay={tunnelModalOpen}
      >
        <TunnelControl
          open={tunnelModalOpen}
          onClose={() => setTunnelModalOpen(false)}
        />
      </ErrorBoundary>

      {chatOpen && (
        <ErrorBoundary
          label="チャット"
          resetLabel="閉じる"
          onReset={() => {
            setChatOpen(false);
            setChatContext(undefined);
          }}
          overlay
        >
        <ChatPanel
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
            chatContext === undefined
              ? undefined
              : `${chatContext.ticketId} について: `
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
        </ErrorBoundary>
      )}

    </div>
    </PopoverCoordinatorProvider>
    </UndoSnackbarProvider>
  );
}
