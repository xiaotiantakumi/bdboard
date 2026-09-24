import type { ViewMode } from '../../uiPersistedState';
import type { BoardMode } from '../../api';
import { useWatchedTickets } from '../WatchedTicketsProvider';
import { useNotificationEvents } from '../../hooks/useNotificationEvents';
import { useWatchedTicketDetails } from '../../hooks/useWatchedTicketDetails';
import { useLastServerContact } from '../../hooks/useLastServerContact';
import { useProjectsData } from '../../hooks/useProjectsData';
import { useSessionsData } from '../../hooks/useSessionsData';
import { useStatusData } from '../../hooks/useStatusData';
import { useBoardData } from '../../hooks/useBoardData';
import { usePendingDecisionsData } from '../../hooks/usePendingDecisionsData';
import { usePrLinksData } from '../../hooks/usePrLinksData';
import { useChatAvailabilityData } from '../../hooks/useChatAvailabilityData';
import { useBoardThresholdsData } from '../../hooks/useBoardThresholdsData';
import { useHarnessStatusData } from '../../hooks/useHarnessStatusData';

type PersistedSetter<T> = (value: T | ((prev: T) => T)) => void;

export interface UseAppDataSourcesParams {
  view: ViewMode;
  boardApiMode: BoardMode;
  selectedProjectIds: string[];
  selectedProjectIdsJoined: string;
  epicFilterId: string | undefined;
  setSelectedProjectIds: PersistedSetter<string[]>;
}

/**
 * App.tsx にフラットに並んでいた「データ取得9系統」
 * (useProjectsData → useSessionsData → useStatusData → useBoardData →
 * useLastServerContact → usePendingDecisionsData → usePrLinksData →
 * useChatAvailabilityData → useBoardThresholdsData → useHarnessStatusData)と、
 * それに続くウォッチ中チケット・通知の3系統
 * (useWatchedTickets → useWatchedTicketDetails → useNotificationEvents)を
 * まとめたフック(bdboard-62p4 第6段、useAppController.ts から分離)。
 * 各フックの呼び出し順・queryKey/enabled/依存配列は元の App.tsx
 * (bdboard-62p4 PR-3 の時点)から1文字も変えていない。
 */
export function useAppDataSources({
  view,
  boardApiMode,
  selectedProjectIds,
  selectedProjectIdsJoined,
  epicFilterId,
  setSelectedProjectIds,
}: UseAppDataSourcesParams) {
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

  const { streamState, lastContactAtMs, reconnect, connectStalled } = useLastServerContact(
    boardQuery.dataUpdatedAt,
  );

  const { pendingDecisionsById, pendingDecisionIds } = usePendingDecisionsData();

  const { prLinksById } = usePrLinksData(selectedProjectIds, selectedProjectIdsJoined);

  const { chatAvailable } = useChatAvailabilityData();

  const { wipLimitsOverrides } = useBoardThresholdsData();

  const { harnessStatusQuery, harnessStatuses } = useHarnessStatusData(view);

  const { watchedSet, stopWatching } = useWatchedTickets();
  const watchedTicketDetails = useWatchedTicketDetails(watchedSet, boardCardsById, stopWatching);

  const notificationEvents = useNotificationEvents({
    watchedTicketIds: watchedSet,
    boardCardsById,
    watchedTicketDetails,
  });

  return {
    projectsQuery,
    chatProjects,
    projectNames,
    projectActiveSessions,
    projectRootPaths,
    totalSessionCount,
    activeSessionCount,
    statusQuery,
    lastRefreshAt,
    statusErrors,
    boardQuery,
    boardTicketIds,
    availableLabels,
    boardCardsById,
    streamState,
    lastContactAtMs,
    reconnect,
    connectStalled,
    pendingDecisionsById,
    pendingDecisionIds,
    prLinksById,
    chatAvailable,
    wipLimitsOverrides,
    harnessStatusQuery,
    harnessStatuses,
    notificationEvents,
  };
}
