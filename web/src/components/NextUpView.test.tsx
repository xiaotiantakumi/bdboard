import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BoardCardDto, BoardDto } from '../api';
import { NextUpView } from './NextUpView';

function makeCard(id: string, title: string, projectId = 'proj-1'): BoardCardDto {
  return {
    ticket: {
      id,
      projectId,
      title,
      status: 'open',
      priority: 2,
      issueType: 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commentCount: 0,
    },
    lane: 'ready',
    projectId,
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

function makeBoard(readyCards: BoardCardDto[]): BoardDto {
  return {
    lanes: {
      ready: readyCards,
      in_progress: [],
      blocked: [],
      done: [],
    },
    cardCount: readyCards.length,
    closedTotal: 0,
    truncatedClosedIds: [],
  };
}

const projectNames = new Map([['proj-1', 'Project One']]);
const projectActiveSessions = new Map([['proj-1', 0]]);

function renderNextUpView(
  board: BoardDto,
  options?: {
    limit?: 5 | 10 | 20;
    onLimitChange?: (limit: 5 | 10 | 20) => void;
  },
) {
  const onLimitChange = options?.onLimitChange ?? vi.fn();
  render(
    <NextUpView
      board={board}
      limit={options?.limit ?? 10}
      onLimitChange={onLimitChange}
      projectNames={projectNames}
      projectActiveSessions={projectActiveSessions}
      pendingDecisionIds={new Set()}
      onCardClick={() => {}}
    />,
  );
  return { onLimitChange };
}

describe('NextUpView', () => {
  it('shows the first N ready cards in server order', () => {
    // サーバー(mergeBoards)が返した順序をフロントで並べ替えないことを保証する。
    // 意図的にタイトル/IDの辞書順とは一致しない順序で渡している。
    const serverOrder = [
      'Task 7',
      'Task 3',
      'Task 11',
      'Task 1',
      'Task 9',
      'Task 2',
      'Task 5',
    ];
    const cards = serverOrder.map((title, index) => makeCard(`ticket-${index + 1}`, title));
    renderNextUpView(makeBoard(cards), { limit: 5 });

    const renderedTitles = screen
      .getAllByRole('button', { name: /Task/ })
      .map((element) => element.querySelector('.card-title')?.textContent);
    expect(renderedTitles).toEqual(serverOrder.slice(0, 5));
    expect(screen.queryByText('Task 2')).not.toBeInTheDocument();
    expect(screen.queryByText('Task 5')).not.toBeInTheDocument();
  });

  it('calls onLimitChange when a limit button is clicked', async () => {
    const user = userEvent.setup();
    const cards = Array.from({ length: 12 }, (_, index) =>
      makeCard(`ticket-${index + 1}`, `Task ${index + 1}`),
    );
    const { onLimitChange } = renderNextUpView(makeBoard(cards), { limit: 10 });

    await user.click(screen.getByRole('button', { name: '20' }));

    expect(onLimitChange).toHaveBeenCalledWith(20);
  });

  it('changes displayed count when the limit changes', () => {
    const cards = Array.from({ length: 12 }, (_, index) =>
      makeCard(`ticket-${index + 1}`, `Task ${index + 1}`),
    );
    const board = makeBoard(cards);
    const onLimitChange = vi.fn();

    const { rerender } = render(
      <NextUpView
        board={board}
        limit={5}
        onLimitChange={onLimitChange}
        projectNames={projectNames}
        projectActiveSessions={projectActiveSessions}
        pendingDecisionIds={new Set()}
        onCardClick={() => {}}
      />,
    );

    expect(screen.getByText('Task 5')).toBeInTheDocument();
    expect(screen.queryByText('Task 6')).not.toBeInTheDocument();

    rerender(
      <NextUpView
        board={board}
        limit={10}
        onLimitChange={onLimitChange}
        projectNames={projectNames}
        projectActiveSessions={projectActiveSessions}
        pendingDecisionIds={new Set()}
        onCardClick={() => {}}
      />,
    );

    expect(screen.getByText('Task 10')).toBeInTheDocument();
    expect(screen.queryByText('Task 11')).not.toBeInTheDocument();
  });

  it('shows an empty state when ready has no cards', () => {
    renderNextUpView(makeBoard([]));

    expect(screen.getByText('着手できるチケットはありません')).toBeInTheDocument();
  });
});
