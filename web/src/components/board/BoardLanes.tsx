import { useRef } from 'react';
import { usePersistedState } from '../../hooks/usePersistedState';
import { type BoardDto, type Lane, type PrBadgeDto } from '../../api';
import { useMatchMedia } from '../../hooks/useMatchMedia';
import { MOBILE_LAYOUT_MEDIA_QUERY } from '../../mediaQueries';
import { type BoardFilter, boardFilterKey } from '../../boardFilter';
import { useBoardDnD } from '../BoardDnDProvider';
import { BoardKeyboardNavProvider, useBoardKeyboardNav } from '../BoardKeyboardNavProvider';
import { LaneColumn } from '../LaneColumn';
import { LaneScrollIndicator } from '../LaneScrollIndicator';
import { type WipLimitsOverrides } from '../../wip-limits';
import { topAwaitingAddon } from './TopAwaitingVideoControls';
import { useAppUiPreferences } from '../../hooks/useAppUiPreferences';
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
  /**
   * bdboard-hipq.3: 上位3件の動画保存の操作を出すか。SplitBoard はプロジェクトごとに
   * BoardLanes を並べるので、1 つだけに出す (複数あると互いの自動保存を整理し合う)。
   */
  showTopAwaitingControls?: boolean;
}

const AWAITING_ONLY_STORAGE_KEY = 'bdboard.mobileAwaitingOnly';

function parseBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

type LanesRowProps = Omit<BoardLanesProps, 'hideDone' | 'showDndError' | 'showTopAwaitingControls'> & {
  lanes: Lane[];
  autoTopAwaitingVideos: boolean | null;
  setAutoTopAwaitingVideos: (enabled: boolean) => void;
};

function LanesRow({
  lanes: allLanes,
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
  autoTopAwaitingVideos,
  setAutoTopAwaitingVideos,
}: LanesRowProps) {
  const boardNav = useBoardKeyboardNav();
  const filterKey = boardFilterKey(filter);
  const lanesRowRef = useRef<HTMLDivElement>(null);
  const isMobile = useMatchMedia(MOBILE_LAYOUT_MEDIA_QUERY);
  const showLaneIndicator = isMobile;
  const [awaitingOnly, setAwaitingOnly] = usePersistedState(
    AWAITING_ONLY_STORAGE_KEY,
    true,
    parseBoolean,
  );
  const lanes: Lane[] = isMobile && awaitingOnly ? ['awaiting_human'] : allLanes;

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
        footerAddon={topAwaitingAddon(lane, filteredCards, autoTopAwaitingVideos, setAutoTopAwaitingVideos)}
      />
    ),
  );

  return (
    <div className="lanes-scroll-region">
      {isMobile && (
        <label className="awaiting-only-toggle">
          <input
            type="checkbox"
            checked={awaitingOnly}
            onChange={(event) => setAwaitingOnly(event.target.checked)}
          />
          確認待ちのみ ({board.lanes.awaiting_human?.length ?? 0})
        </label>
      )}
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
  showTopAwaitingControls = false,
}: BoardLanesProps) {
  const boardDnD = useBoardDnD();
  const { autoTopAwaitingVideos, setAutoTopAwaitingVideos } = useAppUiPreferences();
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
          autoTopAwaitingVideos={showTopAwaitingControls ? autoTopAwaitingVideos : null}
          setAutoTopAwaitingVideos={setAutoTopAwaitingVideos}
        />
      </BoardKeyboardNavProvider>
    </>
  );
}
