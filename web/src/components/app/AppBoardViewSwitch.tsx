import { type UseQueryResult } from '@tanstack/react-query';
import {
  type BoardCardDto,
  type BoardViewDto,
  type PrBadgeDto,
  type ProjectHarnessStatusDto,
} from '../../api';
import { type BoardFilterState } from '../../hooks/useBoardFilterState';
import { type NextUpLimit, type ViewMode } from '../../uiPersistedState';
import { type WipLimitsOverrides } from '../../wip-limits';
import { BoardFilterBar } from '../BoardFilterBar';
import { SplitBoard } from '../BoardView';
import { BulkActionBar } from '../BulkActionBar';
import { NextUpView } from '../NextUpView';
import { type NextUpRunLoopController } from '../nextUpRunLoop';

/**
 * bdboard-62p4 PR-2: AppViewContent からボード系ビュー(split/next)の
 * 表示だけを切り出したもの。フィルタバー・エピック絞り込みインジケータ・
 * 読み込み中/エラー表示・一括操作バー・SplitBoard/NextUpView の
 * 出し分けをまとめる。元は AppViewContent.tsx 1ファイルに収めると ESLint の
 * 200行上限を超えたため分けた(表示専用・state/effect は持たない)。
 * bdboard-mkm1.1 で「統合」タブ削除に伴い BoardLanes(merged 専用の描画分岐)
 * を削除し、split 固定へ単純化した(それ以外の JSX・渡す値は変えていない)。
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
      {view === 'split' && (
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
      {(view === 'split' || view === 'next') &&
        epicFilterId !== undefined && (
          <div className="filter-bar-epic-indicator">
            <span>エピック {epicFilterId} のみ表示中</span>
            <button type="button" className="btn btn-small" onClick={onClearEpicFilter}>
              クリア
            </button>
          </div>
        )}
      {(view === 'split' || view === 'next') && board.query.isLoading && (
        <p className="loading">読み込み中…</p>
      )}
      {(view === 'split' || view === 'next') && board.query.error !== null && (
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
      {(view === 'split' || view === 'next') && (
        <BulkActionBar cardsById={board.cardsById} availableLabels={board.availableLabels ?? []} />
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
        view === 'next' &&
        board.query.data.merged === null && (
          <p className="empty-message">Next Up のデータがありません</p>
        )}
    </>
  );
}
