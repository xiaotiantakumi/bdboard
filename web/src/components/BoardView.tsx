import { useRef } from 'react';
import {
  type BoardDto,
  type BoardCardDto,
  type Lane,
  LANES,
  type PrBadgeDto,
  type ProjectBoardDto,
} from '../api';
import { useMatchMedia } from '../hooks/useMatchMedia';
import { MOBILE_LAYOUT_MEDIA_QUERY } from '../mediaQueries';
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
import {
  LaneScrollIndicator,
  type LaneIndicatorItem,
} from './LaneScrollIndicator';
import { ProjectHarnessBadges } from './ProjectHarnessBadges';
import {
  computeWipStatus,
  resolveWipLimitForLane,
  type WipLimitsOverrides,
} from '../wip-limits';

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
  prLinksById: ReadonlyMap<string, PrBadgeDto>;
  sectionKey: string;
  onCardClick: (ticketId: string) => void;
  showDndError?: boolean;
  collapsedLanes?: ReadonlySet<Lane>;
  onToggleLaneCollapse?: (lane: Lane) => void;
  wipLimitsOverrides?: WipLimitsOverrides;
  /** SplitBoard ではプロジェクト ID、全体ビューでは undefined */
  wipProjectId?: string;
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

function laneIndicatorCountLabel(
  cards: BoardCardDto[],
  unfilteredCount: number,
  wipStatus: { limit: number; count: number; exceeded: true } | undefined,
): string {
  if (wipStatus?.exceeded === true) {
    return `WIP超過: ${wipStatus.count}/${wipStatus.limit}`;
  }
  if (cards.length !== unfilteredCount) {
    return `${cards.length}/${unfilteredCount}`;
  }
  return String(cards.length);
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
  prLinksById,
  sectionKey,
  onCardClick,
  collapsedLanes,
  onToggleLaneCollapse,
  wipLimitsOverrides,
  wipProjectId,
}: {
  lanes: Lane[];
  board: BoardDto;
  stalledOnly: boolean;
  filter: BoardFilter;
  showProjectName: boolean;
  projectNames: Map<string, string>;
  projectActiveSessions: Map<string, number>;
  pendingDecisionIds: ReadonlySet<string>;
  prLinksById: ReadonlyMap<string, PrBadgeDto>;
  sectionKey: string;
  onCardClick: (ticketId: string) => void;
  collapsedLanes?: ReadonlySet<Lane>;
  onToggleLaneCollapse?: (lane: Lane) => void;
  wipLimitsOverrides?: WipLimitsOverrides;
  wipProjectId?: string;
}) {
  const boardNav = useBoardKeyboardNav();
  const filterKey = boardFilterKey(filter);
  const lanesRowRef = useRef<HTMLDivElement>(null);
  const showLaneIndicator = useMatchMedia(MOBILE_LAYOUT_MEDIA_QUERY);

  const laneDerived = lanes.map((lane) => {
    const laneCards = board.lanes[lane] ?? [];
    const afterStalled = applyStalledOnly(laneCards, stalledOnly);
    const filteredCards = filterBoardCards(afterStalled, filter);
    const wipLimit =
      lane === 'in_progress'
        ? resolveWipLimitForLane(wipLimitsOverrides, wipProjectId)
        : undefined;
    const wipStatus =
      lane === 'in_progress' && wipLimit !== undefined
        ? computeWipStatus(laneCards.length, wipLimit)
        : undefined;
    const wipStatusForColumn:
      | { limit: number; count: number; exceeded: true }
      | undefined =
      wipStatus?.exceeded === true && wipStatus.limit !== undefined
        ? { limit: wipStatus.limit, count: wipStatus.count, exceeded: true }
        : undefined;
    return {
      lane,
      filteredCards,
      afterStalled,
      wipStatusForColumn,
    };
  });

  const laneIndicatorItems: LaneIndicatorItem[] = laneDerived.map(
    ({ lane, filteredCards, afterStalled, wipStatusForColumn }) => ({
      lane,
      countLabel: laneIndicatorCountLabel(
        filteredCards,
        afterStalled.length,
        wipStatusForColumn,
      ),
    }),
  );

  const laneColumns = laneDerived.map(
    ({ lane, filteredCards, afterStalled, wipStatusForColumn }) => (
      <LaneColumn
        key={`${sectionKey}-${lane}-${filterKey}`}
        lane={lane}
        cards={filteredCards}
        unfilteredCount={afterStalled.length}
        showProjectName={showProjectName}
        projectNames={projectNames}
        projectActiveSessions={projectActiveSessions}
        pendingDecisionIds={pendingDecisionIds}
        prLinksById={prLinksById}
        onCardClick={onCardClick}
        hiddenCount={
          lane === 'done'
            ? Math.max(0, board.closedTotal - (board.lanes.done?.length ?? 0))
            : undefined
        }
        collapsed={collapsedLanes?.has(lane) ?? false}
        onToggleCollapse={
          onToggleLaneCollapse !== undefined
            ? () => onToggleLaneCollapse(lane)
            : undefined
        }
        wipStatus={wipStatusForColumn}
      />
    ),
  );

  return (
    <div className="lanes-scroll-region">
      <LaneScrollIndicator
        lanes={lanes}
        items={laneIndicatorItems}
        scrollContainerRef={lanesRowRef}
        enabled={showLaneIndicator}
        collapsedLanes={collapsedLanes}
        onToggleCollapse={onToggleLaneCollapse}
      />
      <div
        ref={lanesRowRef}
        className="lanes-row"
        onKeyDown={boardNav?.onContainerKeyDown}
      >
        {laneColumns}
      </div>
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
  prLinksById,
  sectionKey,
  onCardClick,
  showDndError = true,
  collapsedLanes,
  onToggleLaneCollapse,
  wipLimitsOverrides,
  wipProjectId,
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
      <BoardKeyboardNavProvider>
        <LanesRow
          lanes={lanes}
          board={board}
          stalledOnly={stalledOnly}
          filter={filter}
          showProjectName={showProjectName}
          projectNames={projectNames}
          projectActiveSessions={projectActiveSessions}
          pendingDecisionIds={pendingDecisionIds}
          prLinksById={prLinksById}
          sectionKey={sectionKey}
          onCardClick={onCardClick}
          collapsedLanes={collapsedLanes}
          onToggleLaneCollapse={onToggleLaneCollapse}
          wipLimitsOverrides={wipLimitsOverrides}
          wipProjectId={wipProjectId}
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
  prLinksById: ReadonlyMap<string, PrBadgeDto>;
  sectionKeyPrefix: string;
  onCardClick: (ticketId: string) => void;
  onSessionBadgeClick?: (projectId: string) => void;
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
  onSessionBadgeClick,
  collapsedLanes,
  onToggleLaneCollapse,
  wipLimitsOverrides,
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
            prLinksById={prLinksById}
            sectionKey={`${sectionKeyPrefix}-${entry.project.id}`}
            onCardClick={onCardClick}
            showDndError={false}
            collapsedLanes={collapsedLanes}
            onToggleLaneCollapse={onToggleLaneCollapse}
            wipLimitsOverrides={wipLimitsOverrides}
            wipProjectId={entry.project.id}
          />
        </section>
      ))}
    </>
  );
}
