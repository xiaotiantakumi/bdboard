import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCardDto, BoardDto, PrBadgeDto } from '../api';
import { EMPTY_BOARD_FILTER, type BoardFilter } from '../boardFilter';
import { BoardLanes } from './BoardView';

function makeCard(id: string, lane: BoardCardDto['lane'] = 'ready'): BoardCardDto {
  return {
    ticket: {
      id,
      projectId: 'proj-1',
      title: `Ticket ${id}`,
      status: 'open',
      priority: 2,
      issueType: 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commentCount: 0,
    },
    lane,
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
    effectivePriority: 2,
    priorityInheritedFrom: null,
  };
}

function makeBoardWithReadyCards(count: number, idPrefix: string): BoardDto {
  const ready = Array.from({ length: count }, (_, index) =>
    makeCard(`${idPrefix}-${index}`, 'ready'),
  );
  return {
    lanes: {
      ready,
      in_progress: [],
      blocked: [],
      done: [],
    },
    cardCount: count,
    closedTotal: 0,
    truncatedClosedIds: [],
  };
}

const sharedProps = {
  hideDone: true,
  stalledOnly: false,
  filter: EMPTY_BOARD_FILTER,
  showProjectName: false,
  projectNames: new Map<string, string>(),
  projectActiveSessions: new Map<string, number>(),
  pendingDecisionIds: new Set<string>(),
  prLinksById: new Map<string, PrBadgeDto>(),
  sectionKey: 'pagination-test',
  onCardClick: vi.fn(),
};

describe('BoardLanes lane pagination', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('keeps expanded visible count when board data changes without filter change', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <BoardLanes
        {...sharedProps}
        board={makeBoardWithReadyCards(60, 'set-a')}
      />,
    );

    expect(screen.getAllByRole('option')).toHaveLength(50);
    await user.click(screen.getByRole('button', { name: /さらに表示/ }));
    expect(screen.getAllByRole('option')).toHaveLength(60);

    rerender(
      <BoardLanes
        {...sharedProps}
        board={makeBoardWithReadyCards(60, 'set-b')}
      />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(60);
  });

  it('resets visible count to PAGE_SIZE when filter changes', async () => {
    const user = userEvent.setup();
    const board = makeBoardWithReadyCards(60, 'set-c');
    const { rerender } = render(
      <BoardLanes {...sharedProps} board={board} />,
    );

    await user.click(screen.getByRole('button', { name: /さらに表示/ }));
    expect(screen.getAllByRole('option')).toHaveLength(60);

    const activeFilter: BoardFilter = {
      ...EMPTY_BOARD_FILTER,
      priorityCeiling: 4,
    };
    rerender(<BoardLanes {...sharedProps} board={board} filter={activeFilter} />);
    expect(screen.getAllByRole('option')).toHaveLength(50);
  });
});
