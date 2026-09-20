import { type BoardCardDto, type BoardDto, type Lane, LANES } from '../../api';
import {
  type BoardFilter,
  EMPTY_BOARD_FILTER,
  filterBoardCards,
} from '../../boardFilter';

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
