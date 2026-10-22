import { type Lane, type PrBadgeDto, type ProjectBoardDto } from '../../api';
import { type BoardFilter, isBoardFilterActive } from '../../boardFilter';
import { useBoardDnD } from '../BoardDnDProvider';
import { ProjectHarnessBadges } from '../ProjectHarnessBadges';
import { type WipLimitsOverrides } from '../../wip-limits';
import { BoardLanes } from './BoardLanes';
import { hasVisibleCards } from './boardLanesHelpers';

const EMPTY_PROJECT_NAMES = new Map<string, string>();

interface SplitBoardProps {
  projects: ProjectBoardDto[];
  hideDone: boolean;
  stalledOnly: boolean;
  filter: BoardFilter;
  pendingDecisionIds: ReadonlySet<string>;
  prLinksById: ReadonlyMap<string, PrBadgeDto>;
  sectionKeyPrefix: string;
  onCardClick: (ticketId: string) => void;
  collapsedLanes?: ReadonlySet<Lane>;
  onToggleLaneCollapse?: (lane: Lane) => void;
  wipLimitsOverrides?: WipLimitsOverrides;
}

export function SplitBoard({
  projects,
  hideDone,
  stalledOnly,
  filter,
  pendingDecisionIds,
  prLinksById,
  sectionKeyPrefix,
  onCardClick,
  collapsedLanes,
  onToggleLaneCollapse,
  wipLimitsOverrides,
}: SplitBoardProps) {
  const boardDnD = useBoardDnD();
  const visibleProjects = projects.filter((entry) =>
    hasVisibleCards(entry.board, hideDone, stalledOnly, filter),
  );

  // bdboard-hipq.3: 上位3件の動画保存は、確認待ちのカードがある最初のプロジェクトにだけ出す。
  const topAwaitingProjectId = visibleProjects.find(
    (entry) => (entry.board.lanes.awaiting_human?.length ?? 0) > 0,
  )?.project.id;

  if (visibleProjects.length === 0) {
    return (
      <p className="empty-message">
        {isBoardFilterActive(filter)
          ? '表示できるチケットがありません'
          : stalledOnly
            ? '滞留しているチケットはありません'
            : hideDone
              ? '表示できるチケットがありません(doneレーンは非表示中です)'
              : '表示できるチケットがありません'}
      </p>
    );
  }

  return (
    <>
      {boardDnD?.dndError !== undefined &&
        boardDnD.dndError !== null &&
        boardDnD.dndError !== '' && (
          <p className="error-message board-dnd-error">{boardDnD.dndError}</p>
        )}
      {visibleProjects.map((entry) => (
        <section key={entry.project.id} className="board-section">
          <h2 className="board-section-title">
            {entry.project.name} ({entry.board.cardCount} 件)
            <ProjectHarnessBadges projectId={entry.project.id} />
          </h2>
          <BoardLanes
            board={entry.board}
            hideDone={hideDone}
            stalledOnly={stalledOnly}
            filter={filter}
            showProjectName={false}
            projectNames={EMPTY_PROJECT_NAMES}
            pendingDecisionIds={pendingDecisionIds}
            prLinksById={prLinksById}
            sectionKey={`${sectionKeyPrefix}-${entry.project.id}`}
            onCardClick={onCardClick}
            showDndError={false}
            collapsedLanes={collapsedLanes}
            onToggleLaneCollapse={onToggleLaneCollapse}
            wipLimitsOverrides={wipLimitsOverrides}
            wipProjectId={entry.project.id}
            showTopAwaitingControls={entry.project.id === topAwaitingProjectId}
          />
        </section>
      ))}
    </>
  );
}
