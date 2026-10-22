import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardDto } from '../api';
import { EMPTY_BOARD_FILTER } from '../boardFilter';
import { MOBILE_LAYOUT_MEDIA_QUERY } from '../mediaQueries';
import { BoardLanes } from './BoardView';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';

function mockMobileViewport(enabled: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: enabled && query === MOBILE_LAYOUT_MEDIA_QUERY,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function makeBoard(): BoardDto {
  return {
    lanes: {
      ready: [
        {
          ticket: {
            id: 'ready-1',
            projectId: 'proj-1',
            title: 'Ready ticket',
            status: 'open',
            priority: 2,
            issueType: 'task',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
            commentCount: 0,
          },
          lane: 'ready',
          projectId: 'proj-1',
          blockedBy: [],
          blocks: [],
          unblocksCount: 0,
          stalled: false,
          epicProgress: null,
          deferDays: null,
          deferUrgency: null,
          effectivePriority: 2,
          priorityInheritedFrom: null,
        },
      ],
      in_progress: [
        {
          ticket: {
            id: 'wip-1',
            projectId: 'proj-1',
            title: 'WIP ticket',
            status: 'in_progress',
            priority: 2,
            issueType: 'task',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
            commentCount: 0,
          },
          lane: 'in_progress',
          projectId: 'proj-1',
          blockedBy: [],
          blocks: [],
          unblocksCount: 0,
          stalled: false,
          epicProgress: null,
          deferDays: null,
          deferUrgency: null,
          effectivePriority: 2,
          priorityInheritedFrom: null,
        },
      ],
      awaiting_human: [],
      blocked: [],
      done: [],
    },
    cardCount: 2,
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
  pendingDecisionIds: new Set<string>(),
  prLinksById: new Map(),
  sectionKey: 'lane-indicator-test',
  onCardClick: vi.fn(),
};

function renderLanes() {
  return render(
    <WatchedTicketsProvider>
      <BoardLanes {...sharedProps} board={makeBoard()} />
    </WatchedTicketsProvider>,
  );
}

function renderedLanes(): (string | null)[] {
  return [...document.querySelectorAll('[data-lane]')].map((el) => el.getAttribute('data-lane'));
}

describe('BoardLanes mobile lane picker (bdboard-pj9e)', () => {
  beforeEach(() => {
    mockMobileViewport(true);
  });

  afterEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('shows all lanes and no picker on desktop widths', () => {
    mockMobileViewport(false);
    renderLanes();

    expect(screen.queryByRole('navigation', { name: 'レーン切り替え' })).toBeNull();
    expect(renderedLanes()).toEqual(['ready', 'in_progress', 'awaiting_human', 'blocked']);
  });

  it('shows only 確認待ち by default, switches lanes from the picker and remembers the choice', async () => {
    const user = userEvent.setup();
    const view = renderLanes();

    expect(renderedLanes()).toEqual(['awaiting_human']);
    const strip = screen.getByRole('navigation', { name: 'レーン切り替え' });
    expect(within(strip).getByRole('button', { name: '確認待ち (0件)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(within(strip).getByRole('button', { name: '進行中 (1件)' }));
    expect(renderedLanes()).toEqual(['in_progress']);
    view.unmount();

    renderLanes();
    expect(renderedLanes()).toEqual(['in_progress']);
  });
});
