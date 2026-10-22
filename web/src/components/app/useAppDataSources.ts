import type { BoardMode } from '../../api';
import { useReportVisibleProjects } from '../../hooks/useReportVisibleProjects';
import { useWatchedTickets } from '../WatchedTicketsProvider';
import { useNotificationEvents } from '../../hooks/useNotificationEvents';
import { useWatchedTicketDetails } from '../../hooks/useWatchedTicketDetails';
import { useLastServerContact } from '../../hooks/useLastServerContact';
import { useProjectsData } from '../../hooks/useProjectsData';
import { useStatusData } from '../../hooks/useStatusData';
import { useBoardData } from '../../hooks/useBoardData';
import { usePendingDecisionsData } from '../../hooks/usePendingDecisionsData';
import { usePrLinksData } from '../../hooks/usePrLinksData';
import { useChatAvailabilityData } from '../../hooks/useChatAvailabilityData';
import { useBoardThresholdsData } from '../../hooks/useBoardThresholdsData';

type PersistedSetter<T> = (value: T | ((prev: T) => T)) => void;

export interface UseAppDataSourcesParams {
  boardApiMode: BoardMode;
  selectedProjectIds: string[];
  selectedProjectIdsJoined: string;
  epicFilterId: string | undefined;
  setSelectedProjectIds: PersistedSetter<string[]>;
}

/**
 * App.tsx にフラットに並んでいた「データ取得系統」
 * (useProjectsData → useStatusData → useBoardData →
 * useLastServerContact → usePendingDecisionsData → usePrLinksData →
 * useChatAvailabilityData → useBoardThresholdsData)と、それに続く
 * ウォッチ中チケット・通知の3系統
 * (useWatchedTickets → useWatchedTicketDetails → useNotificationEvents)を
 * まとめたフック(bdboard-62p4 第6段、useAppController.ts から分離)。
 * 各フックの呼び出し順・queryKey/enabled/依存配列は元の App.tsx
 * (bdboard-62p4 PR-3 の時点)から1文字も変えていない。
 */
export function useAppDataSources({
  boardApiMode,
  selectedProjectIds,
  selectedProjectIdsJoined,
  epicFilterId,
  setSelectedProjectIds,
}: UseAppDataSourcesParams) {
  const { projectsQuery, chatProjects, projectNames, projectRootPaths } =
    useProjectsData({ setSelectedProjectIds });

  useReportVisibleProjects(selectedProjectIds);

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
    projectRootPaths,
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
    notificationEvents,
  };
}
