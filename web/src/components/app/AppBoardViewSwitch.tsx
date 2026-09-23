import { type UseQueryResult } from '@tanstack/react-query';
import {
  type BoardCardDto,
  type BoardViewDto,
  type PrBadgeDto,
  type ProjectHarnessStatusDto,
} from '../../api';
import { isBoardFilterActive } from '../../boardFilter';
import { type BoardFilterState } from '../../hooks/useBoardFilterState';
import { type NextUpLimit, type ViewMode } from '../../uiPersistedState';
import { type WipLimitsOverrides } from '../../wip-limits';
import { BoardFilterBar } from '../BoardFilterBar';
import { BoardLanes, hasVisibleCards, SplitBoard } from '../BoardView';
import { BulkActionBar } from '../BulkActionBar';
import { NextUpView } from '../NextUpView';
import { type NextUpRunLoopController } from '../nextUpRunLoop';

/**
 * bdboard-62p4 PR-2: AppViewContent からボード系ビュー(merged/split/next)の
 * 表示だけを切り出したもの。フィルタバー・エピック絞り込みインジケータ・
 * 読み込み中/エラー表示・一括操作バー・BoardLanes/SplitBoard/NextUpView の
 * 出し分けをまとめる。元は AppViewContent.tsx 1ファイルに収めると ESLint の
 * 200行上限を超えたため分けた(表示専用・state/effect は持たない)。JSX・
 * 分岐条件・渡す値は App.tsx から移した時点から変えていない。
 */
export interface AppBoardViewSwitchProps {
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
    pendingDecisionIds: ReadonlySet<string>;
    prLinksById: ReadonlyMap<string, PrBadgeDto>;
    wipLimitsOverrides: WipLimitsOverrides;
    selectedProjectIdsJoined: string;
  };
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
}

export function AppBoardViewSwitch({
  view,
  filterState,
  epicFilterId,
  onClearEpicFilter,
  board,
  boardMeta,
  onCardClick,
  onSessionBadgeClick,
  nextUp,
}: AppBoardViewSwitchProps) {
  return (
    <>
      {(view === 'merged' || view === 'split') && (
        <BoardFilterBar
          priorityCeiling={filterState.priorityCeiling}
          onPriorityCeilingChange={filterState.setPriorityCeiling}
          issueTypes={filterState.issueTypes}
          onIssueTypesChange={filterState.setIssueTypes}
          labels={filterState.labels}
          onLabelsChange={filterState.setLabels}
          availableLabels={board.availableLabels}
          filterText={filterState.filterText}
          onFilterTextChange={filterState.setFilterText}
        />
      )}
      {(view === 'merged' || view === 'split' || view === 'next') &&
        epicFilterId !== undefined && (
          <div className="filter-bar-epic-indicator">
            <span>エピック {epicFilterId} のみ表示中</span>
            <button type="button" className="btn btn-small" onClick={onClearEpicFilter}>
              クリア
            </button>
          </div>
        )}
      {(view === 'merged' || view === 'split' || view === 'next') && board.query.isLoading && (
        <p className="loading">読み込み中…</p>
      )}
      {(view === 'merged' || view === 'split' || view === 'next') && board.query.error !== null && (
        <p className="error-message">
          {board.query.error instanceof Error
            ? board.query.error.message
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
        <BulkActionBar cardsById={board.cardsById} availableLabels={board.availableLabels ?? []} />
      )}
      {board.query.data !== undefined && view === 'merged' && board.query.data.merged !== null && (
        (filterState.stalledOnly || isBoardFilterActive(filterState.filter)) &&
        !hasVisibleCards(
          board.query.data.merged,
          filterState.hideDone,
          filterState.stalledOnly,
          filterState.filter,
        ) ? (
          <p className="empty-message">
            {isBoardFilterActive(filterState.filter)
              ? '表示できるチケットがありません'
              : filterState.stalledOnly
                ? '滞留しているチケットはありません'
                : filterState.hideDone
                  ? '表示できるチケットがありません(doneレーンは非表示中です)'
                  : '表示できるチケットがありません'}
          </p>
        ) : (
          <BoardLanes
            board={board.query.data.merged}
            hideDone={filterState.hideDone}
            stalledOnly={filterState.stalledOnly}
            filter={filterState.filter}
            showProjectName
            projectNames={boardMeta.projectNames}
            projectActiveSessions={boardMeta.projectActiveSessions}
            pendingDecisionIds={boardMeta.pendingDecisionIds}
            prLinksById={boardMeta.prLinksById}
            sectionKey={`merged-${boardMeta.selectedProjectIdsJoined}`}
            onCardClick={onCardClick}
            collapsedLanes={filterState.collapsedLanesSet}
            onToggleLaneCollapse={filterState.onToggleLaneCollapse}
            wipLimitsOverrides={boardMeta.wipLimitsOverrides}
          />
        )
      )}
      {board.query.data !== undefined && view === 'split' && (
        <SplitBoard
          projects={board.query.data.projects}
          hideDone={filterState.hideDone}
          stalledOnly={filterState.stalledOnly}
          filter={filterState.filter}
          pendingDecisionIds={boardMeta.pendingDecisionIds}
          prLinksById={boardMeta.prLinksById}
          sectionKeyPrefix={boardMeta.selectedProjectIdsJoined}
          onCardClick={onCardClick}
          onSessionBadgeClick={onSessionBadgeClick}
          collapsedLanes={filterState.collapsedLanesSet}
          onToggleLaneCollapse={filterState.onToggleLaneCollapse}
          wipLimitsOverrides={boardMeta.wipLimitsOverrides}
        />
      )}
      {board.query.data !== undefined && view === 'next' && board.query.data.merged !== null && (
        <NextUpView
          board={board.query.data.merged}
          limit={nextUp.limit}
          onLimitChange={nextUp.onLimitChange}
          showEpics={nextUp.showEpics}
          onShowEpicsChange={nextUp.onShowEpicsChange}
          projectNames={boardMeta.projectNames}
          projectActiveSessions={boardMeta.projectActiveSessions}
          pendingDecisionIds={boardMeta.pendingDecisionIds}
          prLinksById={boardMeta.prLinksById}
          onCardClick={onCardClick}
          batchRun={nextUp.batchRun}
          harnessStatuses={nextUp.harnessStatuses}
        />
      )}
      {board.query.data !== undefined &&
        (view === 'merged' || view === 'next') &&
        board.query.data.merged === null && (
          <p className="empty-message">統合ビューのデータがありません</p>
        )}
    </>
  );
}
