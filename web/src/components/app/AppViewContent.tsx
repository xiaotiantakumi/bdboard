import { type UseQueryResult } from '@tanstack/react-query';
import { type BoardCardDto, type BoardViewDto, type PrBadgeDto, type ProjectHarnessStatusDto } from '../../api';
import { type BoardFilterState } from '../../hooks/useBoardFilterState';
import { type UseNotificationEventsResult } from '../../hooks/useNotificationEvents';
import {
  type ActivityWindowDays,
  type NextUpLimit,
  type StatsWeeks,
  type ViewMode,
} from '../../uiPersistedState';
import { type WipLimitsOverrides } from '../../wip-limits';
import { VIEW_LABELS } from '../../paletteActions';
import { ActivityFeed } from '../ActivityFeed';
import { DailyDigest } from '../DailyDigest';
import { DependencyGraphView } from '../DependencyGraphView';
import { ErrorBoundary } from '../ErrorBoundary';
import { EventCenterPanel } from '../EventCenterPanel';
import { HygienePanel } from '../HygienePanel';
import { type NextUpRunLoopController } from '../nextUpRunLoop';
import { SettingsPanel } from '../SettingsPanel';
import { ThroughputStats } from '../ThroughputStats';
import { AppBoardViewSwitch } from './AppBoardViewSwitch';

/**
 * bdboard-62p4 候補2「ビュー切替本体」。App.tsx の
 * `<ErrorBoundary key={view} …>` 配下(旧 L862-1026)を丸ごと移した表示専用
 * コンポーネント。state・effect・react-query の呼び出しは一切ここに移さず
 * App.tsx 側に残す(App.tsx はこのコンポーネントに props を渡すだけ)。
 *
 * props はこの塊が依存する state/派生値が25個を超えるため(チケット本文の
 * 分析どおり)、関心ごとにオブジェクトへまとめている: `filterState` は
 * useBoardFilterState() の戻り値をそのまま、`board`/`boardMeta` はボード
 * 表示に必要なクエリ結果と派生 Map/Set、`nextUp`/`windows` は各ビュー固有の
 * ウィンドウ幅・limit 状態。JSX・分岐条件・渡す値は元の App.tsx から一切
 * 変えていない(変数参照をグループ化した prop 経由の参照に置き換えただけ)。
 *
 * ボード系ビュー(split/next)の JSX は ESLint の200行上限のため
 * ./AppBoardViewSwitch.tsx へさらに分けた。ここは ErrorBoundary と
 * ボード以外のビュー(activity/digest/stats/hygiene/graph/settings/events)
 * の出し分けだけを持つ。
 */
export interface AppViewContentProps {
  view: ViewMode;
  filterState: BoardFilterState;
  epicFilterId: string | undefined;
  onClearEpicFilter: () => void;
  board: {
    query: Pick<UseQueryResult<BoardViewDto>, 'data' | 'isLoading' | 'error'>;
    cardsById: Map<string, BoardCardDto>;
    availableLabels: string[] | undefined;
  };
  boardMeta: {
    projectNames: Map<string, string>;
    projectActiveSessions: Map<string, number>;
    projectRootPaths: Map<string, string>;
    pendingDecisionIds: ReadonlySet<string>;
    prLinksById: ReadonlyMap<string, PrBadgeDto>;
    wipLimitsOverrides: WipLimitsOverrides;
    selectedProjectIds: readonly string[];
    selectedProjectIdsJoined: string;
  };
  selectedTicketId: string | null;
  onCardClick: (ticketId: string) => void;
  onSessionBadgeClick: (projectId?: string) => void;
  nextUp: {
    limit: NextUpLimit;
    onLimitChange: (limit: NextUpLimit) => void;
    showEpics: boolean;
    onShowEpicsChange: (show: boolean) => void;
    batchRun: NextUpRunLoopController;
    harnessStatuses?: ReadonlyMap<string, ProjectHarnessStatusDto>;
  };
  windows: {
    activityWindowDays: ActivityWindowDays;
    onActivityWindowDaysChange: (days: ActivityWindowDays) => void;
    digestWindowDays: ActivityWindowDays;
    onDigestWindowDaysChange: (days: ActivityWindowDays) => void;
    statsWeeks: StatsWeeks;
    onStatsWeeksChange: (weeks: StatsWeeks) => void;
  };
  notificationEvents: UseNotificationEventsResult;
}

export function AppViewContent({
  view,
  filterState,
  epicFilterId,
  onClearEpicFilter,
  board,
  boardMeta,
  selectedTicketId,
  onCardClick,
  onSessionBadgeClick,
  nextUp,
  windows,
  notificationEvents,
}: AppViewContentProps) {
  return (
    // view をキーにして、別ビューへ切り替えたら壊れた状態を持ち越さない。
    <ErrorBoundary key={view} label={VIEW_LABELS[view]}>
      <AppBoardViewSwitch
        view={view}
        filterState={filterState}
        epicFilterId={epicFilterId}
        onClearEpicFilter={onClearEpicFilter}
        board={board}
        boardMeta={{
          projectNames: boardMeta.projectNames,
          projectActiveSessions: boardMeta.projectActiveSessions,
          pendingDecisionIds: boardMeta.pendingDecisionIds,
          prLinksById: boardMeta.prLinksById,
          wipLimitsOverrides: boardMeta.wipLimitsOverrides,
          selectedProjectIdsJoined: boardMeta.selectedProjectIdsJoined,
        }}
        onCardClick={onCardClick}
        onSessionBadgeClick={onSessionBadgeClick}
        nextUp={nextUp}
      />
      {view === 'activity' && (
        <ActivityFeed
          projectIds={boardMeta.selectedProjectIds}
          windowDays={windows.activityWindowDays}
          onWindowDaysChange={windows.onActivityWindowDaysChange}
          onSelectTicket={onCardClick}
        />
      )}
      {view === 'digest' && (
        <DailyDigest
          projectIds={boardMeta.selectedProjectIds}
          windowDays={windows.digestWindowDays}
          onWindowDaysChange={windows.onDigestWindowDaysChange}
        />
      )}
      {view === 'stats' && (
        <ThroughputStats
          projectIds={boardMeta.selectedProjectIds}
          weeks={windows.statsWeeks}
          onWeeksChange={windows.onStatsWeeksChange}
        />
      )}
      {view === 'hygiene' && (
        <HygienePanel
          projectIds={boardMeta.selectedProjectIds}
          onSelectTicket={onCardClick}
          projectRootPaths={boardMeta.projectRootPaths}
        />
      )}
      {view === 'graph' && (
        <DependencyGraphView
          projectIds={boardMeta.selectedProjectIds}
          focusTicketId={selectedTicketId ?? undefined}
          onCardClick={onCardClick}
        />
      )}
      {view === 'settings' && <SettingsPanel />}
      {view === 'events' && <EventCenterPanel {...notificationEvents} />}
    </ErrorBoundary>
  );
}
