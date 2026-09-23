import { type BoardCardDto, type BoardDto, type Lane, LANES } from '../../api';
import {
  type BoardFilter,
  EMPTY_BOARD_FILTER,
  filterBoardCards,
} from '../../boardFilter';
import {
  computeWipStatus,
  resolveWipLimitForLane,
  type WipLimitsOverrides,
} from '../../wip-limits';
import { type LaneIndicatorItem } from '../LaneScrollIndicator';

export function visibleLanes(hideDone: boolean): Lane[] {
  if (hideDone) {
    return LANES.filter((lane) => lane !== 'done');
  }
  return [...LANES];
}

export function applyStalledOnly(
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

export function laneIndicatorCountLabel(
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

export function deriveLaneRowData(
  lanes: Lane[],
  board: BoardDto,
  stalledOnly: boolean,
  filter: BoardFilter,
  wipLimitsOverrides: WipLimitsOverrides | undefined,
  wipProjectId: string | undefined,
) {
  return lanes.map((lane) => {
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
}

export function laneIndicatorItemsFrom(
  laneDerived: ReturnType<typeof deriveLaneRowData>,
): LaneIndicatorItem[] {
  return laneDerived.map(
    ({ lane, filteredCards, afterStalled, wipStatusForColumn }) => ({
      lane,
      countLabel: laneIndicatorCountLabel(
        filteredCards,
        afterStalled.length,
        wipStatusForColumn,
      ),
    }),
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
