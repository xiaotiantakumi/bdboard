import { useRef } from 'react';
import { type BoardDto, type Lane, type PrBadgeDto } from '../../api';
import { useMatchMedia } from '../../hooks/useMatchMedia';
import { MOBILE_LAYOUT_MEDIA_QUERY } from '../../mediaQueries';
import { type BoardFilter, boardFilterKey } from '../../boardFilter';
import { useBoardDnD } from '../BoardDnDProvider';
import { BoardKeyboardNavProvider, useBoardKeyboardNav } from '../BoardKeyboardNavProvider';
import { LaneColumn } from '../LaneColumn';
import { LaneScrollIndicator } from '../LaneScrollIndicator';
import { type WipLimitsOverrides } from '../../wip-limits';
import {
  deriveLaneRowData,
  laneIndicatorItemsFrom,
  visibleLanes,
} from './boardLanesHelpers';

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

  const laneDerived = deriveLaneRowData(
    lanes,
    board,
    stalledOnly,
    filter,
    wipLimitsOverrides,
    wipProjectId,
  );

  const laneIndicatorItems = laneIndicatorItemsFrom(laneDerived);

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
