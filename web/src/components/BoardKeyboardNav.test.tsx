import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCardDto, BoardDto } from '../api';
import { EMPTY_BOARD_FILTER } from '../boardFilter';
import { BulkSelectionProvider } from './BulkSelectionProvider';
import { BoardLanes } from './BoardView';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';

function makeCard(
  id: string,
  lane: BoardCardDto['lane'],
  title = id,
): BoardCardDto {
  return {
    ticket: {
      id,
      projectId: 'proj-1',
      title,
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

function makeBoard(): BoardDto {
  return {
    lanes: {
      ready: [
        makeCard('ready-1', 'ready', 'Ready One'),
        makeCard('ready-2', 'ready', 'Ready Two'),
        makeCard('ready-3', 'ready', 'Ready Three'),
      ],
      in_progress: [makeCard('progress-1', 'in_progress', 'In Progress One')],
      blocked: [makeCard('deferred-1', 'blocked', 'Deferred One')],
      done: [makeCard('done-1', 'done', 'Done One')],
    },
    cardCount: 6,
    closedTotal: 1,
    truncatedClosedIds: [],
  };
}

const projectNames = new Map([['proj-1', 'Project One']]);
const projectActiveSessions = new Map([['proj-1', 0]]);

function renderBoardLanes(onCardClick = vi.fn()) {
  render(
    <BulkSelectionProvider>
      <WatchedTicketsProvider>
      <BoardLanes
        board={makeBoard()}
        hideDone
        stalledOnly={false}
        filter={EMPTY_BOARD_FILTER}
        showProjectName
        projectNames={projectNames}
        projectActiveSessions={projectActiveSessions}
        pendingDecisionIds={new Set()}
        prLinksById={new Map()}
        sectionKey="test"
        onCardClick={onCardClick}
      />
      </WatchedTicketsProvider>
    </BulkSelectionProvider>,
  );
  return { onCardClick };
}

function checkboxFor(id: string): HTMLElement {
  return screen.getByRole('checkbox', { name: `${id} を選択` });
}

function getCardOptions() {
  return screen.getAllByRole('option');
}

function getCardById(id: string): HTMLElement {
  const card = screen.getByText(id).closest('[role="option"]');
  if (card === null) {
    throw new Error(`Card option not found for ${id}`);
  }
  return card as HTMLElement;
}

describe('BoardKeyboardNav', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('sets tabIndex 0 only on the first card of the first non-empty lane initially', () => {
    renderBoardLanes();

    const cards = getCardOptions();
    expect(cards).toHaveLength(5);

    expect(getCardById('ready-1')).toHaveAttribute('tabindex', '0');
    expect(getCardById('ready-2')).toHaveAttribute('tabindex', '-1');
    expect(getCardById('ready-3')).toHaveAttribute('tabindex', '-1');
    expect(getCardById('progress-1')).toHaveAttribute('tabindex', '-1');
    expect(getCardById('deferred-1')).toHaveAttribute('tabindex', '-1');
  });

  it('moves focus to the next card in the same lane with j and sets aria-selected', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    const firstCard = getCardById('ready-1');
    firstCard.focus();
    await user.keyboard('j');

    expect(getCardById('ready-2')).toHaveFocus();
    expect(getCardById('ready-2')).toHaveAttribute('aria-selected', 'true');
    expect(getCardById('ready-1')).toHaveAttribute('aria-selected', 'false');
  });

  it('moves focus back to the previous card with k', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-2').focus();
    await user.keyboard('k');

    expect(getCardById('ready-1')).toHaveFocus();
    expect(getCardById('ready-1')).toHaveAttribute('aria-selected', 'true');
  });

  it('supports ArrowDown and ArrowUp the same way as j and k', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-1').focus();
    await user.keyboard('{ArrowDown}');
    expect(getCardById('ready-2')).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(getCardById('ready-1')).toHaveFocus();
  });

  it('moves across non-empty lanes with l/h, skipping empty lanes', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-2').focus();
    await user.keyboard('l');

    expect(getCardById('progress-1')).toHaveFocus();
    expect(getCardById('progress-1')).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('h');
    expect(getCardById('ready-2')).toHaveFocus();
    expect(getCardById('ready-2')).toHaveAttribute('aria-selected', 'true');
  });

  it('restores the last focused card in a lane when returning with h/l', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-2').focus();
    await user.keyboard('l');
    expect(getCardById('progress-1')).toHaveFocus();

    await user.keyboard('h');
    expect(getCardById('ready-2')).toHaveFocus();
  });

  it('remembers lane focus from mouse click and restores it when returning', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    await user.click(getCardById('ready-3'));
    expect(getCardById('ready-3')).toHaveFocus();

    await user.keyboard('l');
    expect(getCardById('progress-1')).toHaveFocus();

    await user.keyboard('h');
    expect(getCardById('ready-3')).toHaveFocus();
  });

  it('keeps lane focus memory when lane contents change and re-register', async () => {
    const user = userEvent.setup();
    const initialBoard = makeBoard();
    const { rerender } = render(
      <BulkSelectionProvider>
        <WatchedTicketsProvider>
        <BoardLanes
          board={initialBoard}
          hideDone
          stalledOnly={false}
          filter={EMPTY_BOARD_FILTER}
          showProjectName
          projectNames={projectNames}
          projectActiveSessions={projectActiveSessions}
          pendingDecisionIds={new Set()}
          prLinksById={new Map()}
          sectionKey="test"
          onCardClick={vi.fn()}
        />
        </WatchedTicketsProvider>
      </BulkSelectionProvider>,
    );

    getCardById('ready-2').focus();
    await user.keyboard('l');
    expect(getCardById('progress-1')).toHaveFocus();

    // LaneColumn は idsKey 変化のたびに unregister→register する。記憶したカードが
    // まだ存在するなら、再登録だけでは記憶を消してはいけない。
    const boardWithExtraReadyCard: BoardDto = {
      ...initialBoard,
      lanes: {
        ...initialBoard.lanes,
        ready: [
          makeCard('ready-1', 'ready', 'Ready One'),
          makeCard('ready-2', 'ready', 'Ready Two'),
          makeCard('ready-3', 'ready', 'Ready Three'),
          makeCard('ready-4', 'ready', 'Ready Four'),
        ],
      },
      cardCount: initialBoard.cardCount + 1,
    };

    rerender(
      <BulkSelectionProvider>
        <WatchedTicketsProvider>
        <BoardLanes
          board={boardWithExtraReadyCard}
          hideDone
          stalledOnly={false}
          filter={EMPTY_BOARD_FILTER}
          showProjectName
          projectNames={projectNames}
          projectActiveSessions={projectActiveSessions}
          pendingDecisionIds={new Set()}
          prLinksById={new Map()}
          sectionKey="test"
          onCardClick={vi.fn()}
        />
        </WatchedTicketsProvider>
      </BulkSelectionProvider>,
    );

    await user.keyboard('h');
    expect(getCardById('ready-2')).toHaveFocus();
  });

  it('clamps to index when returning to a lane whose remembered card is gone', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <BulkSelectionProvider>
        <WatchedTicketsProvider>
        <BoardLanes
          board={makeBoard()}
          hideDone
          stalledOnly={false}
          filter={EMPTY_BOARD_FILTER}
          showProjectName
          projectNames={projectNames}
          projectActiveSessions={projectActiveSessions}
          pendingDecisionIds={new Set()}
          prLinksById={new Map()}
          sectionKey="test"
          onCardClick={vi.fn()}
        />
        </WatchedTicketsProvider>
      </BulkSelectionProvider>,
    );

    getCardById('ready-2').focus();
    await user.keyboard('l');
    expect(getCardById('progress-1')).toHaveFocus();

    const boardWithoutReady2: BoardDto = {
      ...makeBoard(),
      lanes: {
        ...makeBoard().lanes,
        ready: [
          makeCard('ready-1', 'ready', 'Ready One'),
          makeCard('ready-3', 'ready', 'Ready Three'),
        ],
      },
      cardCount: 5,
    };

    rerender(
      <BulkSelectionProvider>
        <WatchedTicketsProvider>
        <BoardLanes
          board={boardWithoutReady2}
          hideDone
          stalledOnly={false}
          filter={EMPTY_BOARD_FILTER}
          showProjectName
          projectNames={projectNames}
          projectActiveSessions={projectActiveSessions}
          pendingDecisionIds={new Set()}
          prLinksById={new Map()}
          sectionKey="test"
          onCardClick={vi.fn()}
        />
        </WatchedTicketsProvider>
      </BulkSelectionProvider>,
    );

    await user.keyboard('h');
    expect(getCardById('ready-1')).toHaveFocus();
  });

  it('clamps index on first visit to a lane that has fewer cards', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-3').focus();
    await user.keyboard('l');

    expect(getCardById('progress-1')).toHaveFocus();
  });

  it('skips empty lanes when moving with l without breaking focus', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-1').focus();
    await user.keyboard('l');

    expect(getCardById('progress-1')).toHaveFocus();

    await user.keyboard('l');
    expect(getCardById('deferred-1')).toHaveFocus();
  });

  it('jumps to the last card with End and back to the first with Home', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-1').focus();
    await user.keyboard('{End}');
    expect(getCardById('ready-3')).toHaveFocus();

    await user.keyboard('{Home}');
    expect(getCardById('ready-1')).toHaveFocus();
  });

  it('calls onCardClick when Enter is pressed on a focused card', async () => {
    const user = userEvent.setup();
    const onCardClick = vi.fn();
    renderBoardLanes(onCardClick);

    getCardById('ready-2').focus();
    await user.keyboard('{Enter}');

    expect(onCardClick).toHaveBeenCalledWith('ready-2');
  });

  it('does not move card focus when Meta+j is pressed', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-1').focus();
    await user.keyboard('{Meta>}j{/Meta}');

    expect(getCardById('ready-1')).toHaveFocus();
    expect(getCardById('ready-2')).not.toHaveFocus();
  });

  it('marks only one card as aria-selected at a time', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-1').focus();
    await user.keyboard('j');
    await user.keyboard('l');

    const selected = screen
      .getAllByRole('option')
      .filter((card) => card.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('progress-1');
  });

  it('exposes listbox semantics on lane card containers', () => {
    renderBoardLanes();

    const readyListbox = screen.getByRole('listbox', {
      name: '着手可能 のチケット',
    });
    expect(within(readyListbox).getAllByRole('option')).toHaveLength(3);
  });

  it('toggles bulk selection on the focused card with x', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-2').focus();
    await user.keyboard('x');

    expect(checkboxFor('ready-2')).toBeChecked();
    expect(checkboxFor('ready-1')).not.toBeChecked();

    await user.keyboard('x');
    expect(checkboxFor('ready-2')).not.toBeChecked();
  });

  it('extends bulk selection within a lane with Shift+j and Shift+k', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-1').focus();
    await user.keyboard('{Shift>}j{/Shift}');
    await user.keyboard('{Shift>}j{/Shift}');

    expect(checkboxFor('ready-1')).toBeChecked();
    expect(checkboxFor('ready-2')).toBeChecked();
    expect(checkboxFor('ready-3')).toBeChecked();
    expect(checkboxFor('progress-1')).not.toBeChecked();

    getCardById('ready-3').focus();
    await user.keyboard('{Shift>}k{/Shift}');

    expect(checkboxFor('ready-1')).toBeChecked();
    expect(checkboxFor('ready-2')).toBeChecked();
    expect(checkboxFor('ready-3')).not.toBeChecked();
  });

  it('deselects overshot cards when shrinking a Shift+j/k range in one sequence', async () => {
    const user = userEvent.setup();
    const boardWithFourReady: BoardDto = {
      ...makeBoard(),
      lanes: {
        ...makeBoard().lanes,
        ready: [
          makeCard('ready-1', 'ready', 'Ready One'),
          makeCard('ready-2', 'ready', 'Ready Two'),
          makeCard('ready-3', 'ready', 'Ready Three'),
          makeCard('ready-4', 'ready', 'Ready Four'),
        ],
      },
      cardCount: 7,
    };

    render(
      <BulkSelectionProvider>
        <WatchedTicketsProvider>
          <BoardLanes
            board={boardWithFourReady}
            hideDone
            stalledOnly={false}
            filter={EMPTY_BOARD_FILTER}
            showProjectName
            projectNames={projectNames}
            projectActiveSessions={projectActiveSessions}
            pendingDecisionIds={new Set()}
            prLinksById={new Map()}
            sectionKey="test"
            onCardClick={vi.fn()}
          />
        </WatchedTicketsProvider>
      </BulkSelectionProvider>,
    );

    getCardById('ready-1').focus();
    await user.keyboard('{Shift>}j{/Shift}');
    await user.keyboard('{Shift>}j{/Shift}');
    await user.keyboard('{Shift>}j{/Shift}');

    expect(checkboxFor('ready-1')).toBeChecked();
    expect(checkboxFor('ready-2')).toBeChecked();
    expect(checkboxFor('ready-3')).toBeChecked();
    expect(checkboxFor('ready-4')).toBeChecked();

    await user.keyboard('{Shift>}k{/Shift}');

    expect(checkboxFor('ready-1')).toBeChecked();
    expect(checkboxFor('ready-2')).toBeChecked();
    expect(checkboxFor('ready-3')).toBeChecked();
    expect(checkboxFor('ready-4')).not.toBeChecked();
  });

  it('resets range anchor when focus moves via mouse click before Shift+j/k', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-1').focus();
    await user.keyboard('{Shift>}j{/Shift}');

    expect(checkboxFor('ready-1')).toBeChecked();
    expect(checkboxFor('ready-2')).toBeChecked();
    expect(checkboxFor('ready-3')).not.toBeChecked();

    await user.click(getCardById('ready-3'));
    expect(getCardById('ready-3')).toHaveFocus();

    await user.keyboard('{Shift>}k{/Shift}');
    await user.keyboard('{Shift>}k{/Shift}');

    expect(checkboxFor('ready-1')).toBeChecked();
    expect(checkboxFor('ready-2')).toBeChecked();
    expect(checkboxFor('ready-3')).toBeChecked();
  });

  it('restores default tab stop when the focused card disappears from the board', async () => {
    const user = userEvent.setup();
    const initialBoard = makeBoard();
    const { rerender } = render(
      <BulkSelectionProvider>
        <WatchedTicketsProvider>
        <BoardLanes
          board={initialBoard}
          hideDone
          stalledOnly={false}
          filter={EMPTY_BOARD_FILTER}
          showProjectName
          projectNames={projectNames}
          projectActiveSessions={projectActiveSessions}
          pendingDecisionIds={new Set()}
          prLinksById={new Map()}
          sectionKey="test"
          onCardClick={vi.fn()}
        />
        </WatchedTicketsProvider>
      </BulkSelectionProvider>,
    );

    await user.click(getCardById('ready-2'));
    expect(getCardById('ready-2')).toHaveAttribute('tabindex', '0');
    expect(getCardById('ready-1')).toHaveAttribute('tabindex', '-1');

    const boardWithoutFocusedCard: BoardDto = {
      ...initialBoard,
      lanes: {
        ...initialBoard.lanes,
        ready: [
          makeCard('ready-1', 'ready', 'Ready One'),
          makeCard('ready-3', 'ready', 'Ready Three'),
        ],
      },
      cardCount: initialBoard.cardCount - 1,
    };

    rerender(
      <BulkSelectionProvider>
        <WatchedTicketsProvider>
        <BoardLanes
          board={boardWithoutFocusedCard}
          hideDone
          stalledOnly={false}
          filter={EMPTY_BOARD_FILTER}
          showProjectName
          projectNames={projectNames}
          projectActiveSessions={projectActiveSessions}
          pendingDecisionIds={new Set()}
          prLinksById={new Map()}
          sectionKey="test"
          onCardClick={vi.fn()}
        />
        </WatchedTicketsProvider>
      </BulkSelectionProvider>,
    );

    await waitFor(() => {
      expect(getCardById('ready-1')).toHaveAttribute('tabindex', '0');
    });
    expect(getCardById('ready-3')).toHaveAttribute('tabindex', '-1');

    getCardById('ready-1').focus();
    await user.keyboard('j');
    expect(getCardById('ready-3')).toHaveFocus();
  });

  it('clears bulk selection with Escape', async () => {
    const user = userEvent.setup();
    renderBoardLanes();

    getCardById('ready-1').focus();
    await user.keyboard('x');
    await user.keyboard('{Shift>}j{/Shift}');
    expect(checkboxFor('ready-1')).toBeChecked();
    expect(checkboxFor('ready-2')).toBeChecked();

    await user.keyboard('{Escape}');

    expect(checkboxFor('ready-1')).not.toBeChecked();
    expect(checkboxFor('ready-2')).not.toBeChecked();
  });
});
