import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchBoard,
  fetchChatAvailability,
  fetchPendingDecisions,
  fetchPrLinks,
  fetchProjects,
  fetchSessions,
  fetchStatus,
  fetchSyncHealth,
  type BoardCardDto,
  type Lane,
  type PendingDecisionDto,
  type PrBadgeDto,
  type ProjectDto,
  type SyncHealthDto,
} from './api';
import { BoardLanes, hasVisibleCards, SplitBoard } from './components/BoardView';
import { BoardFilterBar } from './components/BoardFilterBar';
import { BoardFilterPresets } from './components/BoardFilterPresets';
import { BoardDnDProvider } from './components/BoardDnDProvider';
import { BulkActionBar } from './components/BulkActionBar';
import { BulkSelectionProvider } from './components/BulkSelectionProvider';
import { UndoSnackbarProvider } from './components/UndoSnackbar';
import { ActivityFeed } from './components/ActivityFeed';
import { DailyDigest } from './components/DailyDigest';
import { AiQuotaWidget } from './components/AiQuotaWidget';
import { ChatPanel } from './components/ChatPanel';
import { DependencyGraphView } from './components/DependencyGraphView';
import { HygienePanel } from './components/HygienePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { EventCenterPanel } from './components/EventCenterPanel';
import { NextUpView } from './components/NextUpView';
import { ThroughputStats } from './components/ThroughputStats';
import { KeyboardShortcutsPanel } from './components/KeyboardShortcutsPanel';
import { SearchPalette } from './components/SearchPalette';
import { SessionListPanel } from './components/SessionListPanel';
import { TicketDetailPanel } from './components/TicketDetailPanel';
import { TunnelControl } from './components/TunnelControl';
import { isBoardFilterActive } from './boardFilter';
import { useAppBadge } from './hooks/useAppBadge';
import { useNotificationEvents } from './hooks/useNotificationEvents';
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
  validateRecentTickets,
  recordRecentTicket,
  type BoardFilterPreset,
  type BoardFilterPresetState,
} from './uiPersistedState';
import { type StreamState, useBoardStream } from './useBoardStream';
import {
  collectBoardCardsById,
  collectBoardLabels,
  collectBoardTicketIds,
} from './boardTicketIds';
import { buildPaletteActions } from './paletteActions';
import { isTypingTarget } from './keyboardShortcuts';

function streamLabel(state: StreamState): string {
  switch (state) {
    case 'open':
      return '接続中';
    case 'connecting':
      return '接続待ち';
    case 'error':
      return 'エラー';
  }
}

export function formatGeneratedAtAge(generatedAt: string, nowMs: number): string {
  const ageMinutes = Math.floor((nowMs - new Date(generatedAt).getTime()) / 60000);
  if (ageMinutes < 1) {
    return 'たった今';
  }
  if (ageMinutes < 60) {
    return `${ageMinutes}分前`;
  }
  const ageHours = Math.floor(ageMinutes / 60);
  return `${ageHours}時間前`;
}

export function App() {
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
    true,
    validateBoolean,
  );
  const [stalledOnly, setStalledOnly] = usePersistedState(
    UI_STORAGE_KEYS.stalledOnly,
    false,
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
  } = useTicketDeepLink({ view, onViewChange: setView });
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatContext, setChatContext] = useState<
    { projectId: string; ticketId: string } | undefined
  >(undefined);
  const [chatContextToken, setChatContextToken] = useState(0);
  const [sessionListOpen, setSessionListOpen] = useState(false);
  const [sessionListProjectId, setSessionListProjectId] = useState<string | undefined>(
    undefined,
  );

  const streamState = useBoardStream();
  const selectedProjectIdsJoined = selectedProjectIds.join(',');
  const boardApiMode = boardApiModeFromView(view);

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

  const boardQuery = useQuery({
    queryKey: ['board', boardApiMode, selectedProjectIdsJoined, epicFilterId],
    queryFn: () =>
      fetchBoard({
        projectIds: selectedProjectIds,
        view: boardApiMode,
        ...(epicFilterId !== undefined ? { epicId: epicFilterId } : {}),
      }),
  });

  const pendingDecisionsQuery = useQuery({
    queryKey: ['pending-decisions'],
    queryFn: fetchPendingDecisions,
  });

  const prLinksQuery = useQuery({
    queryKey: ['pr-links', selectedProjectIdsJoined],
    queryFn: () => fetchPrLinks(selectedProjectIds),
    retry: false,
  });

  useAppBadge(pendingDecisionsQuery.data?.length);

  const notificationEvents = useNotificationEvents();

  const syncHealthQuery = useQuery({
    queryKey: ['sync-health', selectedProjectIdsJoined],
    queryFn: () => fetchSyncHealth(selectedProjectIds),
    retry: false,
  });

  const chatAvailabilityQuery = useQuery({
    queryKey: ['chat-availability'],
    queryFn: fetchChatAvailability,
    retry: false,
  });

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
    }),
    [
      view,
      selectedProjectIds,
      boardPriorityCeiling,
      boardIssueTypes,
      boardLabels,
      boardFilterText,
    ],
  );

  const handleApplyBoardFilterPreset = useCallback((preset: BoardFilterPreset) => {
    setView(preset.view);
    setSelectedProjectIds(preset.selectedProjectIds);
    setBoardPriorityCeiling(preset.priorityCeiling);
    setBoardIssueTypes(preset.issueTypes);
    setBoardLabels(preset.labels);
    setBoardFilterText(preset.filterText);
  }, [
    setView,
    setSelectedProjectIds,
    setBoardPriorityCeiling,
    setBoardIssueTypes,
    setBoardLabels,
    setBoardFilterText,
  ]);

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

  const syncHealthByProject = useMemo(() => {
    const map = new Map<string, SyncHealthDto>();
    for (const health of syncHealthQuery.data ?? []) {
      map.set(health.projectId, health);
    }
    return map;
  }, [syncHealthQuery.data]);

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

  const handleRefresh = useCallback(() => {
    void boardQuery.refetch();
    void statusQuery.refetch();
  }, [boardQuery, statusQuery]);

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

      event.preventDefault();
      setSearchOpen(true);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

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
        chatOpen ||
        sessionListOpen ||
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
    handleCloseShortcuts,
    handleOpenShortcuts,
    searchOpen,
    sessionListOpen,
    selectedTicketId,
    shortcutsOpen,
  ]);

  const lastRefreshAt = statusQuery.data?.lastRefreshAt;
  const statusErrors = statusQuery.data?.errors ?? [];

  return (
    <UndoSnackbarProvider>
    <div className="app">
      <header className="header">
        <h1 className="header-title">bdboard</h1>

        <div className="header-group">
          <span className="header-label">ビュー</span>
          <div className="toggle-group">
            <button
              type="button"
              className={`toggle-btn${view === 'merged' ? ' active' : ''}`}
              onClick={() => setView('merged')}
            >
              統合
            </button>
            <button
              type="button"
              className={`toggle-btn${view === 'split' ? ' active' : ''}`}
              onClick={() => setView('split')}
            >
              分割
            </button>
            <button
              type="button"
              className={`toggle-btn${view === 'next' ? ' active' : ''}`}
              onClick={() => setView('next')}
            >
              Next Up
            </button>
            <button
              type="button"
              className={`toggle-btn${view === 'activity' ? ' active' : ''}`}
              onClick={() => setView('activity')}
            >
              アクティビティ
            </button>
            <button
              type="button"
              className={`toggle-btn${view === 'digest' ? ' active' : ''}`}
              onClick={() => setView('digest')}
            >
              ダイジェスト
            </button>
            <button
              type="button"
              className={`toggle-btn${view === 'stats' ? ' active' : ''}`}
              onClick={() => setView('stats')}
            >
              統計
            </button>
            <button
              type="button"
              className={`toggle-btn${view === 'hygiene' ? ' active' : ''}`}
              onClick={() => setView('hygiene')}
            >
              健全性
            </button>
            <button
              type="button"
              className={`toggle-btn${view === 'graph' ? ' active' : ''}`}
              onClick={() => setView('graph')}
            >
              依存グラフ
            </button>
            <button
              type="button"
              className={`toggle-btn${view === 'events' ? ' active' : ''}`}
              onClick={() => setView('events')}
            >
              イベント
              {notificationEvents.unreadCount > 0
                ? ` (${notificationEvents.unreadCount})`
                : ''}
            </button>
            <button
              type="button"
              className={`toggle-btn${view === 'settings' ? ' active' : ''}`}
              onClick={() => setView('settings')}
            >
              設定
            </button>
          </div>
        </div>

        <div className="header-group project-filter">
          <details>
            <summary>
              プロジェクト
              {selectedProjectIds.length > 0
                ? ` (${selectedProjectIds.length} 件選択)`
                : ' (全件)'}
            </summary>
            <div className="project-list">
              <button type="button" className="btn btn-small" onClick={handleSelectAll}>
                全選択
              </button>
              <button type="button" className="btn btn-small" onClick={handleClearAll}>
                全解除
              </button>
              {(projectsQuery.data ?? []).map((project) => (
                <label key={project.id} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={selectedProjectIds.includes(project.id)}
                    onChange={(event) =>
                      handleToggleProject(project.id, event.target.checked)
                    }
                  />
                  {project.name}
                </label>
              ))}
            </div>
          </details>
        </div>

        <BoardFilterPresets
          presets={boardFilterPresets}
          onPresetsChange={setBoardFilterPresets}
          currentState={boardFilterPresetState}
          onApplyPreset={handleApplyBoardFilterPreset}
        />

        {(view === 'merged' || view === 'split') && (
          <>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={hideDone}
                onChange={(event) => setHideDone(event.target.checked)}
              />
              done レーンを隠す
            </label>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={stalledOnly}
                onChange={(event) => setStalledOnly(event.target.checked)}
              />
              滞留のみ表示
            </label>
          </>
        )}

        <div className="stream-indicator">
          <span className={`stream-dot ${streamState}`} />
          <span>{streamLabel(streamState)}</span>
        </div>

        {boardQuery.data?.generatedAt !== null &&
          boardQuery.data?.generatedAt !== undefined && (
            <span
              className="meta-text"
              title={new Date(boardQuery.data.generatedAt).toLocaleString()}
            >
              盤面取得:{' '}
              {formatGeneratedAtAge(boardQuery.data.generatedAt, Date.now())}
            </span>
          )}

        {lastRefreshAt !== null && lastRefreshAt !== undefined && (
          <span className="meta-text">
            最終更新: {new Date(lastRefreshAt).toLocaleString()}
          </span>
        )}

        <button
          type="button"
          className="meta-text meta-text-btn"
          onClick={() => handleOpenSessionList()}
        >
          セッション: {totalSessionCount}（稼働中 {activeSessionCount}）
        </button>

        <button
          type="button"
          className="btn btn-shortcuts-help"
          aria-label="キーボードショートカット (?)"
          onClick={handleOpenShortcuts}
        >
          ?
        </button>

        <button
          type="button"
          className="btn btn-search"
          aria-label="コマンドパレット (Cmd+K)"
          onClick={handleOpenSearch}
        >
          検索
        </button>

        <button
          type="button"
          className="btn"
          onClick={handleRefresh}
          disabled={isRefreshing}
        >
          {isRefreshing ? '更新中…' : '手動更新'}
        </button>

        {chatAvailable && (
          <button
            type="button"
            className="btn"
            onClick={() => setChatOpen(true)}
          >
            チャット
          </button>
        )}

        <AiQuotaWidget />

        <TunnelControl />

        {statusErrors.length > 0 && (
          <div className="error-banner">
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
      </header>

      <main className="main">
        <BoardDnDProvider>
        <BulkSelectionProvider>
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
        {(view === 'merged' || view === 'split') && (
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
            syncHealthByProject={syncHealthByProject}
            collapsedLanes={collapsedLanesSet}
            onToggleLaneCollapse={handleToggleLaneCollapse}
          />
        )}
        {boardQuery.data !== undefined && view === 'next' && boardQuery.data.merged !== null && (
          <NextUpView
            board={boardQuery.data.merged}
            limit={nextUpLimit}
            onLimitChange={setNextUpLimit}
            projectNames={projectNames}
            projectActiveSessions={projectActiveSessions}
            pendingDecisionIds={pendingDecisionIds}
            prLinksById={prLinksById}
            onCardClick={handleSelectTicket}
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
        </BulkSelectionProvider>
        </BoardDnDProvider>
      </main>

      {selectedTicketId !== null && (
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
          isTicketOnBoard={isTicketOnBoard}
          onFilterByEpic={handleFilterByEpic}
          onTicketViewed={handleRecordRecentTicket}
          availableLabels={availableLabels}
        />
      )}

      {sessionListOpen && (
        <SessionListPanel
          projectId={sessionListProjectId}
          onClose={handleCloseSessionList}
        />
      )}

      {shortcutsOpen && (
        <KeyboardShortcutsPanel onClose={handleCloseShortcuts} />
      )}

      {searchOpen && (
        <SearchPalette
          onClose={handleCloseSearch}
          onSelect={handleSelectTicket}
          actions={paletteActions}
          recentTickets={recentTickets}
        />
      )}

      {chatOpen && (
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
      )}

    </div>
    </UndoSnackbarProvider>
  );
}
