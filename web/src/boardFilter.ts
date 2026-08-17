import type { BoardCardDto } from './api';

export interface BoardFilter {
  priorityCeiling: number | null; // null = 上限なし。カードは priority <= ceiling で通す
  issueTypes: string[]; // 空配列 = 全 type 通す。非空なら含まれる type のみ通す
  labels: string[]; // 空配列 = 全ラベル通す。非空ならいずれか1つを持つカードのみ通す
  text: string; // 空/空白のみ = 通す。title と id の部分一致(大文字小文字無視)
}

export const EMPTY_BOARD_FILTER: BoardFilter = {
  priorityCeiling: null,
  issueTypes: [],
  labels: [],
  text: '',
};

export function boardFilterKey(filter: BoardFilter): string {
  const ceiling =
    filter.priorityCeiling === null ? '' : String(filter.priorityCeiling);
  const types = [...filter.issueTypes].sort().join(',');
  const labels = [...filter.labels].sort().join(',');
  const text = filter.text.trim();
  return `${ceiling}|${types}|${labels}|${text}`;
}

export function isBoardFilterActive(filter: BoardFilter): boolean {
  return (
    filter.priorityCeiling !== null ||
    filter.issueTypes.length > 0 ||
    filter.labels.length > 0 ||
    filter.text.trim() !== ''
  );
}

export function cardMatchesBoardFilter(
  card: BoardCardDto,
  filter: BoardFilter,
): boolean {
  // 優先度は effectivePriority(親からの継承値)ではなく card.ticket.priority(生の値)を使う。
  // ボード全体フィルタはチケット自身の優先度ラベルで絞り込む意図的な選択。
  if (
    filter.priorityCeiling !== null &&
    card.ticket.priority > filter.priorityCeiling
  ) {
    return false;
  }

  if (
    filter.issueTypes.length > 0 &&
    !filter.issueTypes.includes(card.ticket.issueType)
  ) {
    return false;
  }

  if (filter.labels.length > 0) {
    const cardLabels = card.ticket.labels;
    if (
      cardLabels === undefined ||
      !filter.labels.some((label) => cardLabels.includes(label))
    ) {
      return false;
    }
  }

  const trimmed = filter.text.trim();
  if (trimmed !== '') {
    const normalized = trimmed.toLowerCase();
    const matchesText =
      card.ticket.title.toLowerCase().includes(normalized) ||
      card.ticket.id.toLowerCase().includes(normalized);
    if (!matchesText) {
      return false;
    }
  }

  return true;
}

export function filterBoardCards(
  cards: BoardCardDto[],
  filter: BoardFilter,
): BoardCardDto[] {
  if (!isBoardFilterActive(filter)) {
    return cards;
  }
  return cards.filter((card) => cardMatchesBoardFilter(card, filter));
}
