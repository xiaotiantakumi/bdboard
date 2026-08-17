import { describe, expect, it } from 'vitest';
import type { BoardCardDto } from './api';
import {
  boardFilterKey,
  cardMatchesBoardFilter,
  EMPTY_BOARD_FILTER,
  filterBoardCards,
  isBoardFilterActive,
  type BoardFilter,
} from './boardFilter';

function makeCard(
  overrides: {
    id?: string;
    title?: string;
    priority?: number;
    issueType?: string;
    effectivePriority?: number;
  } = {},
): BoardCardDto {
  const priority = overrides.priority ?? 2;
  return {
    ticket: {
      id: overrides.id ?? 'bdboard-test',
      projectId: 'proj-1',
      title: overrides.title ?? 'Test ticket',
      status: 'open',
      priority,
      issueType: overrides.issueType ?? 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commentCount: 0,
    },
    lane: 'ready',
    projectId: 'proj-1',
    blockedBy: [],
    blocks: [],
    unblocksCount: 0,
    liveness: null,
    sessions: [],
    stalled: false,
    epicProgress: null,
    deferDays: null,
    deferUrgency: null,
    effectivePriority: overrides.effectivePriority ?? priority,
    priorityInheritedFrom: null,
  };
}

describe('boardFilterKey', () => {
  it('returns the same key regardless of issueTypes order', () => {
    const filterA: BoardFilter = {
      ...EMPTY_BOARD_FILTER,
      issueTypes: ['bug', 'task'],
    };
    const filterB: BoardFilter = {
      ...EMPTY_BOARD_FILTER,
      issueTypes: ['task', 'bug'],
    };
    expect(boardFilterKey(filterA)).toBe(boardFilterKey(filterB));
  });

  it('returns different keys when filter criteria differ', () => {
    const base = boardFilterKey(EMPTY_BOARD_FILTER);
    expect(
      boardFilterKey({ ...EMPTY_BOARD_FILTER, priorityCeiling: 1 }),
    ).not.toBe(base);
    expect(
      boardFilterKey({ ...EMPTY_BOARD_FILTER, issueTypes: ['bug'] }),
    ).not.toBe(base);
    expect(
      boardFilterKey({ ...EMPTY_BOARD_FILTER, text: 'alpha' }),
    ).not.toBe(base);
  });
});

describe('isBoardFilterActive', () => {
  it('returns false for empty filter', () => {
    expect(isBoardFilterActive(EMPTY_BOARD_FILTER)).toBe(false);
  });

  it('returns true when any criterion is set', () => {
    expect(
      isBoardFilterActive({ ...EMPTY_BOARD_FILTER, priorityCeiling: 1 }),
    ).toBe(true);
    expect(
      isBoardFilterActive({ ...EMPTY_BOARD_FILTER, issueTypes: ['bug'] }),
    ).toBe(true);
    expect(
      isBoardFilterActive({ ...EMPTY_BOARD_FILTER, text: 'alpha' }),
    ).toBe(true);
    expect(
      isBoardFilterActive({ ...EMPTY_BOARD_FILTER, text: '   ' }),
    ).toBe(false);
  });
});

describe('cardMatchesBoardFilter', () => {
  it('passes all cards when filter is empty', () => {
    const card = makeCard();
    expect(cardMatchesBoardFilter(card, EMPTY_BOARD_FILTER)).toBe(true);
  });

  it('filters by raw priority, not effectivePriority', () => {
    const card = makeCard({ priority: 3, effectivePriority: 0 });
    const filter: BoardFilter = { ...EMPTY_BOARD_FILTER, priorityCeiling: 1 };
    expect(cardMatchesBoardFilter(card, filter)).toBe(false);
  });

  it('includes cards at the priority ceiling', () => {
    const card = makeCard({ priority: 1 });
    const filter: BoardFilter = { ...EMPTY_BOARD_FILTER, priorityCeiling: 1 };
    expect(cardMatchesBoardFilter(card, filter)).toBe(true);
  });

  it('filters by issue type when types are selected', () => {
    const bug = makeCard({ issueType: 'bug' });
    const task = makeCard({ issueType: 'task' });
    const filter: BoardFilter = { ...EMPTY_BOARD_FILTER, issueTypes: ['bug'] };
    expect(cardMatchesBoardFilter(bug, filter)).toBe(true);
    expect(cardMatchesBoardFilter(task, filter)).toBe(false);
  });

  it('matches text against title and id case-insensitively', () => {
    const card = makeCard({
      id: 'bdboard-Alpha',
      title: 'Fix Beta issue',
    });
    expect(
      cardMatchesBoardFilter(card, { ...EMPTY_BOARD_FILTER, text: 'alpha' }),
    ).toBe(true);
    expect(
      cardMatchesBoardFilter(card, { ...EMPTY_BOARD_FILTER, text: 'BETA' }),
    ).toBe(true);
    expect(
      cardMatchesBoardFilter(card, { ...EMPTY_BOARD_FILTER, text: 'gamma' }),
    ).toBe(false);
  });

  it('ignores whitespace-only text', () => {
    const card = makeCard({ title: 'Anything' });
    expect(
      cardMatchesBoardFilter(card, { ...EMPTY_BOARD_FILTER, text: '  \t  ' }),
    ).toBe(true);
  });

  it('combines criteria with AND', () => {
    const card = makeCard({
      priority: 1,
      issueType: 'bug',
      title: 'Crash on login',
      id: 'bdboard-crash',
    });
    const filter: BoardFilter = {
      priorityCeiling: 1,
      issueTypes: ['bug'],
      text: 'login',
    };
    expect(cardMatchesBoardFilter(card, filter)).toBe(true);
    expect(
      cardMatchesBoardFilter(card, { ...filter, issueTypes: ['task'] }),
    ).toBe(false);
    expect(
      cardMatchesBoardFilter(card, { ...filter, priorityCeiling: 0 }),
    ).toBe(false);
    expect(cardMatchesBoardFilter(card, { ...filter, text: 'logout' })).toBe(
      false,
    );
  });
});

describe('filterBoardCards', () => {
  const cards = [
    makeCard({ id: 'bdboard-a', priority: 0, issueType: 'bug', title: 'A' }),
    makeCard({ id: 'bdboard-b', priority: 2, issueType: 'task', title: 'B' }),
    makeCard({ id: 'bdboard-c', priority: 4, issueType: 'chore', title: 'C' }),
  ];

  it('returns the same array reference when filter is inactive', () => {
    expect(filterBoardCards(cards, EMPTY_BOARD_FILTER)).toBe(cards);
  });

  it('returns a filtered copy when filter is active', () => {
    const result = filterBoardCards(cards, {
      ...EMPTY_BOARD_FILTER,
      priorityCeiling: 1,
    });
    expect(result).not.toBe(cards);
    expect(result.map((card) => card.ticket.id)).toEqual(['bdboard-a']);
  });
});
