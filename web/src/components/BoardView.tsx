import {
  type BoardDto,
  type BoardCardDto,
  type Lane,
  LANES,
  type ProjectBoardDto,
  type SyncHealthDto,
} from '../api';
import {
  type BoardFilter,
  boardFilterKey,
  EMPTY_BOARD_FILTER,
  filterBoardCards,
  isBoardFilterActive,
} from '../boardFilter';
import { useBoardDnD } from './BoardDnDProvider';
import { BoardKeyboardNavProvider, useBoardKeyboardNav } from './BoardKeyboardNavProvider';
import { LaneColumn } from './LaneColumn';
import { ProjectHarnessBadges } from './ProjectHarnessBadges';
import { SyncHealthBadge } from './SyncHealthBadge';

const EMPTY_PROJECT_NAMES = new Map<string, string>();
const EMPTY_SESSION_COUNTS = new Map<string, number>();

interface BoardLanesProps {
  board: BoardDto;
  hideDone: boolean;
  stalledOnly: boolean;
  filter: BoardFilter;
  showProjectName: boolean;
  projectNames: Map<string, string>;
  projectActiveSessions: Map<string, number>;
  pendingDecisionIds: ReadonlySet<string>;
  sectionKey: string;
  onCardClick: (ticketId: string) => void;
  showDndError?: boolean;
}

function visibleLanes(hideDone: boolean): Lane[] {
  if (hideDone) {
    return LANES.filter((lane) => lane !== 'done');
  }
  return [...LANES];
}

function applyStalledOnly(
  cards: BoardCardDto[],
  stalledOnly: boolean,
): BoardCardDto[] {
  if (!stalledOnly) {
    return cards;
  }
  return cards.filter((card) => card.stalled);
}

function filterCards(
  cards: BoardCardDto[],
  stalledOnly: boolean,
  filter: BoardFilter = EMPTY_BOARD_FILTER,
): BoardCardDto[] {
  return filterBoardCards(applyStalledOnly(cards, stalledOnly), filter);
}

function LanesRow({
  lanes,
  board,
  stalledOnly,
  filter,
  showProjectName,
  projectNames,
  projectActiveSessions,
  pendingDecisionIds,
  sectionKey,
  onCardClick,
}: {
  lanes: Lane[];
  board: BoardDto;
  stalledOnly: boolean;
  filter: BoardFilter;
  showProjectName: boolean;
  projectNames: Map<string, string>;
  projectActiveSessions: Map<string, number>;
  pendingDecisionIds: ReadonlySet<string>;
  sectionKey: string;
  onCardClick: (ticketId: string) => void;
}) {
  const boardNav = useBoardKeyboardNav();
  const filterKey = boardFilterKey(filter);

  return (
    <div className="lanes-row" onKeyDown={boardNav?.onContainerKeyDown}>
      {lanes.map((lane) => {
        const laneCards = board.lanes[lane] ?? [];
        const afterStalled = applyStalledOnly(laneCards, stalledOnly);
        const filteredCards = filterBoardCards(afterStalled, filter);
        return (
        <LaneColumn
          key={`${sectionKey}-${lane}-${filterKey}`}
          lane={lane}
          cards={filteredCards}
          unfilteredCount={afterStalled.length}
          showProjectName={showProjectName}
          projectNames={projectNames}
          projectActiveSessions={projectActiveSessions}
          pendingDecisionIds={pendingDecisionIds}
          onCardClick={onCardClick}
          hiddenCount={
            lane === 'done'
              ? Math.max(0, board.closedTotal - (board.lanes.done?.length ?? 0))
              : undefined
          }
        />
        );
      })}
    </div>
  );
}

export function BoardLanes({
  board,
  hideDone,
  stalledOnly,
  filter,
  showProjectName,
  projectNames,
  projectActiveSessions,
  pendingDecisionIds,
  sectionKey,
  onCardClick,
  showDndError = true,
}: BoardLanesProps) {
  const boardDnD = useBoardDnD();
  const lanes = visibleLanes(hideDone);

  return (
    <>
      {showDndError &&
        boardDnD?.dndError !== undefined &&
        boardDnD.dndError !== null &&
        boardDnD.dndError !== '' && (
          <p className="error-message board-dnd-error">{boardDnD.dndError}</p>
        )}
      <BoardKeyboardNavProvider onActivate={onCardClick}>
        <LanesRow
          lanes={lanes}
          board={board}
          stalledOnly={stalledOnly}
          filter={filter}
          showProjectName={showProjectName}
          projectNames={projectNames}
          projectActiveSessions={projectActiveSessions}
          pendingDecisionIds={pendingDecisionIds}
          sectionKey={sectionKey}
          onCardClick={onCardClick}
        />
      </BoardKeyboardNavProvider>
    </>
  );
}

export function hasVisibleCards(
  board: BoardDto,
  hideDone: boolean,
  stalledOnly = false,
  filter: BoardFilter = EMPTY_BOARD_FILTER,
): boolean {
  const lanes = visibleLanes(hideDone);
  return lanes.some((lane) =>
    filterCards(board.lanes[lane] ?? [], stalledOnly, filter).length > 0,
  );
}

interface SplitBoardProps {
  projects: ProjectBoardDto[];
  hideDone: boolean;
  stalledOnly: boolean;
  filter: BoardFilter;
  pendingDecisionIds: ReadonlySet<string>;
  sectionKeyPrefix: string;
  onCardClick: (ticketId: string) => void;
  onSessionBadgeClick?: (projectId: string) => void;
  readonly syncHealthByProject?: Map<string, SyncHealthDto>;
}

export function SplitBoard({
  projects,
  hideDone,
  stalledOnly,
  filter,
  pendingDecisionIds,
  sectionKeyPrefix,
  onCardClick,
  onSessionBadgeClick,
  syncHealthByProject,
}: SplitBoardProps) {
  const boardDnD = useBoardDnD();
  const visibleProjects = projects.filter((entry) =>
    hasVisibleCards(entry.board, hideDone, stalledOnly, filter),
  );

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
            {entry.project.sessionCount > 0 && (
              onSessionBadgeClick !== undefined ? (
                <button
                  type="button"
                  className="session-badge session-badge-btn"
                  onClick={() => onSessionBadgeClick(entry.project.id)}
                >
                  ● {entry.project.sessionCount} セッション（稼働中{' '}
                  {entry.project.activeSessionCount}）
                </button>
              ) : (
                <span className="session-badge">
                  ● {entry.project.sessionCount} セッション（稼働中{' '}
                  {entry.project.activeSessionCount}）
                </span>
              )
            )}
            <SyncHealthBadge health={syncHealthByProject?.get(entry.project.id)} />
            <ProjectHarnessBadges projectId={entry.project.id} />
          </h2>
          <BoardLanes
            board={entry.board}
            hideDone={hideDone}
            stalledOnly={stalledOnly}
            filter={filter}
            showProjectName={false}
            projectNames={EMPTY_PROJECT_NAMES}
            projectActiveSessions={EMPTY_SESSION_COUNTS}
            pendingDecisionIds={pendingDecisionIds}
            sectionKey={`${sectionKeyPrefix}-${entry.project.id}`}
            onCardClick={onCardClick}
            showDndError={false}
          />
        </section>
      ))}
    </>
  );
}
