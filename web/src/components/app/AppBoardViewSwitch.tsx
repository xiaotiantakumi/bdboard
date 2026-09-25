import { type UseQueryResult } from '@tanstack/react-query';
import {
  type BoardCardDto,
  type BoardViewDto,
  type PrBadgeDto,
} from '../../api';
import { type BoardFilterState } from '../../hooks/useBoardFilterState';
import { type ViewMode } from '../../uiPersistedState';
import { type WipLimitsOverrides } from '../../wip-limits';
import { BoardFilterBar } from '../BoardFilterBar';
import { SplitBoard } from '../BoardView';
import { BulkActionBar } from '../BulkActionBar';
import { type NextUpRunLoopController } from '../nextUpRunLoop';

/**
 * bdboard-62p4 PR-2: AppViewContent からボード系ビュー(split)の
 * 表示だけを切り出したもの。フィルタバー・エピック絞り込みインジケータ・
 * 読み込み中/エラー表示・一括操作バー・SplitBoard の出し分けをまとめる。元は
 * AppViewContent.tsx 1ファイルに収めると ESLint の200行上限を超えたため分けた
 * (表示専用・state/effect は持たない)。
 * bdboard-mkm1.1 で「統合」タブ削除に伴い BoardLanes(merged 専用の描画分岐)
 * を削除し、split 固定へ単純化した。bdboard-mkm1.3 で Next Up ビュー
 * (NextUpView とその表示件数/epic表示トグル)を削除し、split 単独のビュー
 * 切替へさらに単純化した(それ以外の JSX・渡す値は変えていない)。
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
    batchRun: NextUpRunLoopController;
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
      {view === 'split' && epicFilterId !== undefined && (
        <div className="filter-bar-epic-indicator">
          <span>エピック {epicFilterId} のみ表示中</span>
          <button type="button" className="btn btn-small" onClick={onClearEpicFilter}>
            クリア
          </button>
        </div>
      )}
      {view === 'split' && board.query.isLoading && (
        <p className="loading">読み込み中…</p>
      )}
      {view === 'split' && board.query.error !== null && (
        <p className="error-message">
          {board.query.error instanceof Error
            ? board.query.error.message
            : 'ボードの読み込みに失敗しました'}
        </p>
      )}
      {/* BulkSelectionProvider は ErrorBoundary の外に置いてビュー横断で選択を
          保つ設計 (PR#129)。「▶ 実行」(bdboard-mkm1.2) には App が持つ実行
          ループを渡す。バーはビューごとに出し入れされるが、ループと進捗
          (ヘッダーのチップ) はビューを切り替えても続く。 */}
      {view === 'split' && (
        <BulkActionBar
          cardsById={board.cardsById}
          availableLabels={board.availableLabels ?? []}
          agentRun={{
            batchRun: nextUp.batchRun,
            board: board.query.data,
            projectNames: boardMeta.projectNames,
          }}
        />
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
    </>
  );
}
