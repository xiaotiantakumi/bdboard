import type { UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import type { ProjectDto } from '../api';
import { buildPaletteActions, type PaletteAction } from '../paletteActions';
import { recordRecentTicket, type RecentTicketEntry } from '../uiPersistedState';
import type { ViewMode } from '../uiPersistedState/view';

// usePersistedState が返す完全な setter 形。useBoardFilterState.ts /
// useAppFilterPresets.ts の PersistedSetter<T> と同じ意図。
type PersistedSetter<T> = (value: T | ((prev: T) => T)) => void;

type RefetchableQuery = Pick<UseQueryResult<unknown, Error>, 'isFetching' | 'refetch'>;

export interface AppActionsParams {
  // 最近開いたチケット記録
  setRecentTickets: PersistedSetter<RecentTicketEntry[]>;
  projectNames: Map<string, string>;

  // ボード上の存在判定
  boardTicketIds: Set<string>;

  // 更新(手動リフレッシュ)
  boardQuery: RefetchableQuery;
  statusQuery: RefetchableQuery;
  reconnect: () => void;

  // プロジェクト選択
  setSelectedProjectIds: PersistedSetter<string[]>;
  projectsQuery: Pick<UseQueryResult<ProjectDto[], Error>, 'data'>;

  // コマンドパレット
  setView: PersistedSetter<ViewMode>;
  handleOpenChat: () => void;
  setHideDone: PersistedSetter<boolean>;
  hideDone: boolean;
  setStalledOnly: PersistedSetter<boolean>;
  stalledOnly: boolean;
  handleOpenSessionList: (projectId?: string) => void;
  handleOpenHelp: () => void;
  chatAvailable: boolean;

  // エピック絞り込み
  setEpicFilterId: (ticketId: string | undefined) => void;
  handleCloseDetail: () => void;
  epicFilterId: string | undefined;
  view: ViewMode;
}

export interface AppActionsResult {
  handleRecordRecentTicket: (entry: { id: string; title: string; projectId: string }) => void;
  isTicketOnBoard: (ticketId: string) => boolean;
  isRefreshing: boolean;
  handleRefresh: () => void;
  handleToggleProject: (projectId: string, checked: boolean) => void;
  handleSelectAll: () => void;
  handleClearAll: () => void;
  paletteActions: PaletteAction[];
  handleFilterByEpic: (ticketId: string) => void;
}

/**
 * App.tsx のデータ取得9系統(useXxxData)に隣接して並んでいた、単発の
 * アクションハンドラ群(bdboard-62p4 第5段。ticket 本文「次にやる人へ」の
 * 候補2)。最近開いたチケット記録・ボード在籍判定・手動リフレッシュ・
 * プロジェクト選択・コマンドパレット・エピック絞り込みの6つの関心を
 * ひとまとめにする。
 *
 * hook 呼び出し順について: 元の App.tsx ではこれら(handleRecordRecentTicket
 * → isTicketOnBoard → handleRefresh → handleToggleProject → handleSelectAll
 * → handleClearAll → paletteActions → handleFilterByEpic → epicFilterId
 * 切り替え effect)は、データ取得9系統 + useWatchedTickets +
 * useWatchedTicketDetails + useNotificationEvents の直後、
 * useAppKeyboardShortcuts の直前で宣言されていた。このフックも App.tsx 内の
 * 同じ位置で1回だけ呼ぶため、内部の useCallback(7個)/useMemo(1個)/
 * useEffect(1個、epicFilterId 切り替え)は全体で見ても元と同じ相対位置で
 * 登録される。epicFilterId 切り替え effect は epicFilterId のみに依存し
 * 他の hook の実行順を前提にしていないため、位置を保つだけで元の挙動と
 * 一致する(詳細は元コードの epicFilterId effect コメント、
 * bdboard-3tw.95 review 由来)。
 *
 * boardQuery/statusQuery は TanStack Query v5 の trackResult が毎レンダー
 * 新しい Proxy を生成するため、オブジェクトそのものを依存配列に入れると
 * useCallback が実質メモ化されない (bdboard-t43h)。このフックの内部でも
 * refetch を分割代入して依存配列にはその安定参照だけを使う(呼び出し元の
 * App.tsx から見て boardQuery/statusQuery オブジェクト自体は毎レンダー変わって
 * よい — このフックへの引数として渡ること自体はメモ化の有無に影響しない)。
 */
export function useAppActions(params: AppActionsParams): AppActionsResult {
  const {
    setRecentTickets,
    projectNames,
    boardTicketIds,
    boardQuery,
    statusQuery,
    reconnect,
    setSelectedProjectIds,
    projectsQuery,
    setView,
    handleOpenChat,
    setHideDone,
    hideDone,
    setStalledOnly,
    stalledOnly,
    handleOpenSessionList,
    handleOpenHelp,
    chatAvailable,
    setEpicFilterId,
    handleCloseDetail,
    epicFilterId,
    view,
  } = params;

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
    // setEpicFilterId は useState の setter で常に安定な参照だが、ここでは
    // hook の引数として受け取っているため react-hooks/exhaustive-deps が
    // 静的解析でそれを追跡できない(元の App.tsx では useState から直接
    // 分割代入していたため deps に不要だった)。挙動は変わらないので deps に
    // 加えるだけで警告を解消する。
  }, [handleCloseDetail, setEpicFilterId]);

  // bdboard-3tw.95 review (M3): switching the view synchronously inside
  // handleFilterByEpic raced with handleCloseDetail()'s window.history.back() —
  // the resulting async popstate (useTicketDeepLink's onLocationChange) restores
  // the view that was active when the ticket panel was opened, which lands
  // *after* our synchronous setView and silently overwrites it. Applying the
  // switch from an effect keyed only on epicFilterId sidesteps the race: it
  // reads `view` once, from the same render as the epicFilterId update (before
  // any popstate has had a chance to fire), and — now that the epic-filter
  // indicator/board render for 'split' | 'next' (bdboard-3tw.95
  // review M2) — it only needs to force a switch when the ticket was opened
  // from a non-board view (activity/digest/stats/hygiene/graph) that can't
  // show the filtered board at all.
  useEffect(() => {
    if (epicFilterId === undefined) {
      return;
    }
    if (view !== 'split' && view !== 'next') {
      setView('split');
    }
    // Intentionally epicFilterId-only: this must fire once per epic-filter
    // change, not on every subsequent view change (which would fight the
    // user's own navigation, e.g. from 'split' to 'next' while the filter is
    // still active).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epicFilterId]);

  return {
    handleRecordRecentTicket,
    isTicketOnBoard,
    isRefreshing,
    handleRefresh,
    handleToggleProject,
    handleSelectAll,
    handleClearAll,
    paletteActions,
    handleFilterByEpic,
  };
}
