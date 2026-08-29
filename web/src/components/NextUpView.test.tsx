import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardCardDto, BoardDto } from '../api';
import { NextUpView } from './NextUpView';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';

function renderWithWatch(ui: ReactElement) {
  return render(<WatchedTicketsProvider>{ui}</WatchedTicketsProvider>);
}

function makeCard(
  id: string,
  title: string,
  projectId = 'proj-1',
  options?: { issueType?: BoardCardDto['ticket']['issueType']; priority?: number },
): BoardCardDto {
  const priority = options?.priority ?? 2;
  const issueType = options?.issueType ?? 'task';
  return {
    ticket: {
      id,
      projectId,
      title,
      status: 'open',
      priority,
      issueType,
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
    effectivePriority: priority,
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
    showEpics?: boolean;
    onShowEpicsChange?: (show: boolean) => void;
  },
) {
  const onLimitChange = options?.onLimitChange ?? vi.fn();
  const onShowEpicsChange = options?.onShowEpicsChange ?? vi.fn();
  renderWithWatch(
    <NextUpView
      board={board}
      limit={options?.limit ?? 10}
      onLimitChange={onLimitChange}
      showEpics={options?.showEpics ?? false}
      onShowEpicsChange={onShowEpicsChange}
      projectNames={projectNames}
      projectActiveSessions={projectActiveSessions}
      pendingDecisionIds={new Set()}
      prLinksById={new Map()}
      onCardClick={() => {}}
    />,
  );
  return { onLimitChange, onShowEpicsChange };
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

  it('excludes epics from the main list while preserving server order among regular tickets', () => {
    const cards = [
      makeCard('epic-1', 'Epic Alpha', 'proj-1', { issueType: 'epic', priority: 0 }),
      makeCard('task-1', 'Task One', 'proj-1', { issueType: 'task', priority: 1 }),
      makeCard('epic-2', 'Epic Beta', 'proj-1', { issueType: 'epic', priority: 0 }),
      makeCard('task-2', 'Task Two', 'proj-1', { issueType: 'task', priority: 2 }),
      makeCard('task-3', 'Task Three', 'proj-1', { issueType: 'task', priority: 3 }),
    ];
    renderNextUpView(makeBoard(cards), { limit: 5 });

    const renderedTitles = screen
      .getAllByRole('button', { name: /Task/ })
      .map((element) => element.querySelector('.card-title')?.textContent);
    expect(renderedTitles).toEqual(['Task One', 'Task Two', 'Task Three']);
    expect(screen.queryByText('Epic Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('Epic Beta')).not.toBeInTheDocument();
  });

  it('does not render the epic section when showEpics is false', () => {
    const cards = [
      makeCard('epic-1', 'Epic Alpha', 'proj-1', { issueType: 'epic', priority: 0 }),
      makeCard('task-1', 'Task One', 'proj-1'),
    ];
    renderNextUpView(makeBoard(cards), { showEpics: false });

    expect(screen.queryByRole('heading', { name: 'Epic' })).not.toBeInTheDocument();
    expect(screen.queryByText('Epic Alpha')).not.toBeInTheDocument();
  });

  it('renders the epic section when showEpics is true', () => {
    const cards = [
      makeCard('epic-1', 'Epic Alpha', 'proj-1', { issueType: 'epic', priority: 0 }),
      makeCard('task-1', 'Task One', 'proj-1'),
      makeCard('epic-2', 'Epic Beta', 'proj-1', { issueType: 'epic', priority: 0 }),
    ];
    renderNextUpView(makeBoard(cards), { showEpics: true, limit: 5 });

    expect(screen.getByRole('heading', { name: 'Epic' })).toBeInTheDocument();
    expect(screen.getByText('Epic Alpha')).toBeInTheDocument();
    expect(screen.getByText('Epic Beta')).toBeInTheDocument();
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

  it('calls onShowEpicsChange when the epic toggle is clicked', async () => {
    const user = userEvent.setup();
    const cards = [
      makeCard('epic-1', 'Epic Alpha', 'proj-1', { issueType: 'epic', priority: 0 }),
      makeCard('task-1', 'Task One', 'proj-1'),
    ];
    const { onShowEpicsChange } = renderNextUpView(makeBoard(cards), { showEpics: false });

    await user.click(screen.getByRole('button', { name: 'epic を表示 (1)' }));

    expect(onShowEpicsChange).toHaveBeenCalledWith(true);
  });

  it('changes displayed count when the limit changes', () => {
    const cards = Array.from({ length: 12 }, (_, index) =>
      makeCard(`ticket-${index + 1}`, `Task ${index + 1}`),
    );
    const board = makeBoard(cards);
    const onLimitChange = vi.fn();
    const onShowEpicsChange = vi.fn();

    const { rerender } = renderWithWatch(
      <NextUpView
        board={board}
        limit={5}
        onLimitChange={onLimitChange}
        showEpics={false}
        onShowEpicsChange={onShowEpicsChange}
        projectNames={projectNames}
        projectActiveSessions={projectActiveSessions}
        pendingDecisionIds={new Set()}
        prLinksById={new Map()}
        onCardClick={() => {}}
      />,
    );

    expect(screen.getByText('Task 5')).toBeInTheDocument();
    expect(screen.queryByText('Task 6')).not.toBeInTheDocument();

    rerender(
      <WatchedTicketsProvider>
        <NextUpView
          board={board}
          limit={10}
          onLimitChange={onLimitChange}
          showEpics={false}
          onShowEpicsChange={onShowEpicsChange}
          projectNames={projectNames}
          projectActiveSessions={projectActiveSessions}
          pendingDecisionIds={new Set()}
          prLinksById={new Map()}
          onCardClick={() => {}}
        />
      </WatchedTicketsProvider>,
    );

    expect(screen.getByText('Task 10')).toBeInTheDocument();
    expect(screen.queryByText('Task 11')).not.toBeInTheDocument();
  });

  it('shows an empty state when ready has no cards', () => {
    renderNextUpView(makeBoard([]));

    expect(screen.getByText('着手できるチケットはありません')).toBeInTheDocument();
  });

  it('marks the selected display limit with aria-pressed', () => {
    renderNextUpView(makeBoard([]), { limit: 5 });

    expect(screen.getByRole('button', { name: '5' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '10' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '20' })).toHaveAttribute('aria-pressed', 'false');
  });
});
