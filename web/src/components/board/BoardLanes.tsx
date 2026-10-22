import { usePersistedState } from '../../hooks/usePersistedState';
import { type BoardDto, type Lane, LANES, type PrBadgeDto } from '../../api';
import { useMatchMedia } from '../../hooks/useMatchMedia';
import { MOBILE_LAYOUT_MEDIA_QUERY } from '../../mediaQueries';
import { type BoardFilter, boardFilterKey } from '../../boardFilter';
import { useBoardDnD } from '../BoardDnDProvider';
import { BoardKeyboardNavProvider, useBoardKeyboardNav } from '../BoardKeyboardNavProvider';
import { LaneColumn } from '../LaneColumn';
import { LanePicker } from '../LanePicker';
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

/** bdboard-pj9e: スマホ幅で表示する 1 レーン (端末ごとに保存)。 */
const MOBILE_LANE_STORAGE_KEY = 'bdboard.mobileLane';
const DEFAULT_MOBILE_LANE: Lane = 'awaiting_human';

function parseLane(value: unknown): Lane | null {
  return LANES.find((lane) => lane === value) ?? null;
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
  const isMobile = useMatchMedia(MOBILE_LAYOUT_MEDIA_QUERY);
  const [storedMobileLane, setMobileLane] = usePersistedState(
    MOBILE_LANE_STORAGE_KEY,
    DEFAULT_MOBILE_LANE,
    parseLane,
  );
  // 保存済みのレーンが今は非表示 (例: 完了を隠している) なら既定へ戻す
  const mobileLane = allLanes.includes(storedMobileLane) ? storedMobileLane : DEFAULT_MOBILE_LANE;

  const allLaneDerived = deriveLaneRowData(
    allLanes,
    board,
    stalledOnly,
    filter,
    wipLimitsOverrides,
    wipProjectId,
  );

  const laneIndicatorItems = laneIndicatorItemsFrom(allLaneDerived);
  const laneDerived = isMobile
    ? allLaneDerived.filter(({ lane }) => lane === mobileLane)
    : allLaneDerived;

  const laneColumns = laneDerived.map(
    ({ lane, filteredCards, afterStalled, wipStatusForColumn }) => (
      <LaneColumn
        key={`${sectionKey}-${lane}-${filterKey}`}
        lane={lane}
        cards={filteredCards}
        unfilteredCount={afterStalled.length}
        showProjectName={showProjectName}
        projectNames={projectNames}
        pendingDecisionIds={pendingDecisionIds}
        prLinksById={prLinksById}
        onCardClick={onCardClick}
        hiddenCount={
          lane === 'done'
            ? Math.max(0, board.closedTotal - (board.lanes.done?.length ?? 0))
            : undefined
        }
        collapsed={!isMobile && (collapsedLanes?.has(lane) ?? false)}
        onToggleCollapse={
          !isMobile && onToggleLaneCollapse !== undefined
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
      <LanePicker
        items={laneIndicatorItems}
        selectedLane={mobileLane}
        onSelect={setMobileLane}
        enabled={isMobile}
      />
      <div
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
