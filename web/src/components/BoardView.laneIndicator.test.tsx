import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardDto } from '../api';
import { EMPTY_BOARD_FILTER } from '../boardFilter';
import { BoardLanes } from './BoardView';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';

type IoCallback = IntersectionObserverCallback;

let intersectionCallback: IoCallback | null = null;

class MockIntersectionObserver {
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  readonly unobserve = vi.fn();

  constructor(callback: IoCallback) {
    intersectionCallback = callback;
  }
}

function mockMobileViewport(enabled: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: enabled && query === '(max-width: 700px)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function triggerIntersection(entries: IntersectionObserverEntry[]) {
  intersectionCallback?.(entries, {} as IntersectionObserver);
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
          liveness: null,
          sessions: [],
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
          liveness: null,
          sessions: [],
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
  projectActiveSessions: new Map<string, number>(),
  pendingDecisionIds: new Set<string>(),
  prLinksById: new Map(),
  sectionKey: 'lane-indicator-test',
  onCardClick: vi.fn(),
};

describe('BoardLanes mobile lane indicator', () => {
  beforeEach(() => {
    intersectionCallback = null;
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    Element.prototype.scrollIntoView = vi.fn();
    mockMobileViewport(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not render the lane indicator on desktop widths', () => {
    mockMobileViewport(false);

    render(
      <WatchedTicketsProvider>
        <BoardLanes {...sharedProps} board={makeBoard()} />
      </WatchedTicketsProvider>,
    );

    expect(screen.queryByRole('navigation', { name: 'レーン切り替え' })).toBeNull();
  });

  it('highlights the most visible lane and scrolls when an indicator item is pressed', async () => {
    const user = userEvent.setup();
    render(
      <WatchedTicketsProvider>
        <BoardLanes {...sharedProps} board={makeBoard()} />
      </WatchedTicketsProvider>,
    );

    const readyLane = document.querySelector('[data-lane="ready"]');
    const inProgressLane = document.querySelector('[data-lane="in_progress"]');
    expect(readyLane).not.toBeNull();
    expect(inProgressLane).not.toBeNull();

    act(() => {
      triggerIntersection([
        {
          target: readyLane!,
          intersectionRatio: 0.2,
          isIntersecting: true,
        } as IntersectionObserverEntry,
        {
          target: inProgressLane!,
          intersectionRatio: 0.85,
          isIntersecting: true,
        } as IntersectionObserverEntry,
      ]);
    });

    const strip = screen.getByRole('navigation', { name: 'レーン切り替え' });
    const inProgressButton = await within(strip).findByRole('button', {
      name: '進行中 (1件)',
    });
    await waitFor(() => {
      expect(inProgressButton).toHaveAttribute('aria-current', 'true');
    });

    const readyButton = within(strip).getByRole('button', {
      name: '着手可能 (1件)',
    });
    expect(readyButton).not.toHaveAttribute('aria-current');

    await user.click(readyButton);

    const scrollSpy = vi.mocked(Element.prototype.scrollIntoView);
    expect(scrollSpy).toHaveBeenCalledWith({
      behavior: 'smooth',
      inline: 'start',
      block: 'nearest',
    });
    expect(scrollSpy.mock.contexts.at(-1)).toBe(readyLane);
  });
});
