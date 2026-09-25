import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  createTicketRunsInvalidator,
  useNextUpRunLoopController,
} from '../nextUpRunLoop';
import { useHeaderHeightVar } from '../../hooks/useHeaderHeightVar';
import { useAppUiPreferences } from '../../hooks/useAppUiPreferences';
import { useBoardFilterState } from '../../hooks/useBoardFilterState';
import { useTicketDeepLink } from '../../hooks/useTicketDeepLink';
import { useAppOverlays } from '../../hooks/useAppOverlays';
import { useAppKeyboardShortcuts } from '../../hooks/useAppKeyboardShortcuts';
import { useAppFilterPresets } from '../../hooks/useAppFilterPresets';
import { useAppActions } from '../../hooks/useAppActions';
import { boardApiModeFromView } from '../../uiPersistedState';
import { useAppDataSources } from './useAppDataSources';

/**
 * App.tsx 本体(旧53〜320行目、JSXを除く全hook呼び出し)を1つの組み立てフックへ
 * 集約したもの(bdboard-62p4 第6段)。TicketDetailPanel の
 * useTicketDetailController(bdboard-sso1.5)と同じ「controller hook +
 * presentational body」構成を踏襲する。データ取得9系統+ウォッチ/通知3系統は
 * 行数の都合で useAppDataSources.ts にさらに分けた(呼び出し位置はこのフックの
 * 元の宣言順のまま、詳細は useAppDataSources.ts の JSDoc 参照)。
 *
 * hook 呼び出し順は元の App.tsx から変えていない。唯一の例外は、元は
 * boardFilterState / nextUpBatchRun (queryClient + useNextUpRunLoopController)
 * と互い違いに並んでいた11個の usePersistedState を useAppUiPreferences.ts へ
 * まとめたことで、これら11個が1箇所にまとまって呼ばれるようになった点のみ
 * (useAppUiPreferences.ts の JSDoc の通り、いずれも他の hook の実行順序に
 * 依存しない usePersistedState 呼び出しなので観測可能な挙動は変わらない)。
 * それ以外の呼び出し(useHeaderHeightVar → ui → boardFilterState →
 * queryClient/nextUpBatchRun → epicFilterId → useTicketDeepLink →
 * useAppOverlays → useAppFilterPresets → useAppDataSources(データ取得9系統+
 * ウォッチ/通知3系統)→ useAppActions → useAppKeyboardShortcuts)は元の宣言順
 * のまま。
 *
 * 戻り値は元の App.tsx の JSX が参照していたローカル変数をそのまま返す。値が
 * 増減しないよう ui/dataSources はまるごと spread し (個別フィールド名は
 * useAppUiPreferences.ts / useAppDataSources.ts の戻り値のまま)、
 * boardFilterState 由来の hideDone/setHideDone/stalledOnly/setStalledOnly の
 * ような個々の値は useAppFilterPresets/useAppActions
 * への受け渡しだけに使うローカル変数を持たず、呼び出し側で
 * `boardFilterState.xxx` を直接参照する形にした (AppBody.tsx /
 * AppOverlaySection.tsx も同様に `controller.boardFilterState.xxx` を参照する
 * — 元の App.tsx が持っていた個別の hideDone/setHideDone 等のローカル変数は
 * boardFilterState オブジェクトの中身と完全に同じもので、値自体は変わらない)。
 */
export function useAppController() {
  useHeaderHeightVar();

  const ui = useAppUiPreferences();
  const { view, setView, selectedProjectIds, setSelectedProjectIds, boardFilterPresets, setRecentTickets } =
    ui;

  const boardFilterState = useBoardFilterState();

  const queryClient = useQueryClient();
  const nextUpBatchRun = useNextUpRunLoopController({
    onTicketRunsChanged: createTicketRunsInvalidator(queryClient),
  });

  const [epicFilterId, setEpicFilterId] = useState<string | undefined>(undefined);
  const {
    selectedTicketId,
    selectTicket: handleSelectTicket,
    closeDetail: handleCloseDetail,
    canGoBackTicket,
    goBackTicket,
  } = useTicketDeepLink({ view, onViewChange: setView });

  const overlays = useAppOverlays(selectedTicketId);

  const selectedProjectIdsJoined = selectedProjectIds.join(',');
  const boardApiMode = boardApiModeFromView(view);

  const { boardFilterPresetState, handleApplyBoardFilterPreset } = useAppFilterPresets({
    view,
    selectedProjectIds,
    priorityCeiling: boardFilterState.priorityCeiling,
    issueTypes: boardFilterState.issueTypes,
    labels: boardFilterState.labels,
    filterText: boardFilterState.filterText,
    hideDone: boardFilterState.hideDone,
    stalledOnly: boardFilterState.stalledOnly,
    setView,
    setSelectedProjectIds,
    setPriorityCeiling: boardFilterState.setPriorityCeiling,
    setIssueTypes: boardFilterState.setIssueTypes,
    setLabels: boardFilterState.setLabels,
    setFilterText: boardFilterState.setFilterText,
    setHideDone: boardFilterState.setHideDone,
    setStalledOnly: boardFilterState.setStalledOnly,
    boardFilterPresets,
  });

  const dataSources = useAppDataSources({
    boardApiMode,
    selectedProjectIds,
    selectedProjectIdsJoined,
    epicFilterId,
    setSelectedProjectIds,
  });
  const { projectNames, boardTicketIds, boardQuery, statusQuery, reconnect, projectsQuery, chatAvailable } =
    dataSources;

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
    setHideDone: boardFilterState.setHideDone,
    hideDone: boardFilterState.hideDone,
    setStalledOnly: boardFilterState.setStalledOnly,
    stalledOnly: boardFilterState.stalledOnly,
    handleOpenSessionList: overlays.handleOpenSessionList,
    handleOpenHelp: overlays.handleOpenHelp,
    chatAvailable,
    setEpicFilterId,
    handleCloseDetail,
    epicFilterId,
    view,
  });

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

  return {
    ...ui,
    boardFilterState,
    boardFilterPresetState,
    handleApplyBoardFilterPreset,
    nextUpBatchRun,
    epicFilterId,
    setEpicFilterId,
    selectedProjectIdsJoined,
    selectedTicketId,
    handleSelectTicket,
    handleCloseDetail,
    canGoBackTicket,
    goBackTicket,
    overlays,
    ...dataSources,
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
