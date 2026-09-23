import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCardDto, BoardDto, BoardViewDto } from '../api';

vi.mock('../api', () => ({
  fetchBoard: vi.fn(),
  LANES: ['ready', 'in_progress', 'awaiting_human', 'blocked', 'done'],
}));

import { fetchBoard } from '../api';
import { useBoardData } from './useBoardData';

const fetchBoardMock = vi.mocked(fetchBoard);

function makeCard(
  id: string,
  lane: BoardCardDto['lane'] = 'ready',
  labels?: string[],
): BoardCardDto {
  return {
    ticket: {
      id,
      projectId: 'proj-1',
      title: id,
      status: lane === 'done' ? 'closed' : 'open',
      priority: 2,
      issueType: 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commentCount: 0,
      labels: labels ?? (id === 'bdboard-labeled' ? ['frontend'] : []),
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

function makeBoard(overrides: Partial<BoardDto> = {}): BoardDto {
  return {
    lanes: { ready: [], in_progress: [], awaiting_human: [], blocked: [], done: [] },
    cardCount: 0,
    closedTotal: 0,
    truncatedClosedIds: [],
    ...overrides,
  };
}

function makeBoardView(overrides: Partial<BoardViewDto> = {}): BoardViewDto {
  return {
    mode: 'merged',
    generatedAt: '2026-09-24T00:00:00.000Z',
    projects: [],
    merged: makeBoard(),
    ...overrides,
  };
}

function renderBoardData(params: {
  boardApiMode?: 'merged' | 'split';
  selectedProjectIds?: string[];
  selectedProjectIdsJoined?: string;
  epicFilterId?: string | undefined;
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () =>
      useBoardData({
        boardApiMode: params.boardApiMode ?? 'merged',
        selectedProjectIds: params.selectedProjectIds ?? [],
        selectedProjectIdsJoined: params.selectedProjectIdsJoined ?? '',
        epicFilterId: params.epicFilterId,
      }),
    { wrapper },
  );
  return { ...view, queryClient };
}

describe('useBoardData', () => {
  beforeEach(() => {
    fetchBoardMock.mockReset();
  });

  it('builds the queryKey from boardApiMode/selectedProjectIdsJoined/epicFilterId, exactly as App.tsx did', async () => {
    fetchBoardMock.mockResolvedValue(makeBoardView());
    const { result, queryClient } = renderBoardData({
      boardApiMode: 'split',
      selectedProjectIdsJoined: 'p1,p2',
      epicFilterId: 'bdboard-epic',
    });

    await waitFor(() => expect(result.current.boardQuery.isSuccess).toBe(true));

    const cached = queryClient
      .getQueryCache()
      .find({ queryKey: ['board', 'split', 'p1,p2', 'bdboard-epic'] });
    expect(cached).toBeDefined();
  });

  it('calls fetchBoard with projectIds/view and omits epicId when epicFilterId is undefined', async () => {
    fetchBoardMock.mockResolvedValue(makeBoardView());
    const { result } = renderBoardData({
      boardApiMode: 'merged',
      selectedProjectIds: ['p1'],
      selectedProjectIdsJoined: 'p1',
      epicFilterId: undefined,
    });

    await waitFor(() => expect(result.current.boardQuery.isSuccess).toBe(true));

    expect(fetchBoardMock).toHaveBeenCalledWith({ projectIds: ['p1'], view: 'merged' });
  });

  it('includes epicId in the fetchBoard call when epicFilterId is set', async () => {
    fetchBoardMock.mockResolvedValue(makeBoardView());
    const { result } = renderBoardData({
      selectedProjectIds: ['p1'],
      selectedProjectIdsJoined: 'p1',
      epicFilterId: 'bdboard-epic',
    });

    await waitFor(() => expect(result.current.boardQuery.isSuccess).toBe(true));

    expect(fetchBoardMock).toHaveBeenCalledWith({
      projectIds: ['p1'],
      view: 'merged',
      epicId: 'bdboard-epic',
    });
  });

  it('derives boardTicketIds/availableLabels/boardCardsById from merged and per-project boards', async () => {
    const boardView = makeBoardView({
      merged: makeBoard({
        lanes: {
          ready: [
            makeCard('bdboard-merged'),
            // Deliberately unsorted, multi-label card so this test actually
            // exercises the compareStrings sort on availableLabels rather than
            // passing vacuously on a single-label fixture (bdboard-62p4 PR-3
            // opus review finding #5).
            makeCard('bdboard-multilabel', 'ready', ['zebra', 'apple']),
          ],
          in_progress: [],
          awaiting_human: [],
          blocked: [],
          done: [],
        },
      }),
      projects: [
        {
          project: {
            id: 'proj-1',
            name: 'Project One',
            rootPath: '/repo',
            prefixes: ['bdboard'],
            sessionCount: 0,
            activeSessionCount: 0,
            incompleteTicketCount: 0,
            sessions: [],
          },
          board: makeBoard({
            lanes: {
              ready: [makeCard('bdboard-labeled')],
              in_progress: [],
              awaiting_human: [],
              blocked: [],
              done: [],
            },
          }),
        },
      ],
    });
    fetchBoardMock.mockResolvedValue(boardView);
    const { result } = renderBoardData();

    await waitFor(() => expect(result.current.boardQuery.data).toEqual(boardView));

    expect(result.current.boardTicketIds.has('bdboard-merged')).toBe(true);
    expect(result.current.boardTicketIds.has('bdboard-labeled')).toBe(true);
    expect(result.current.boardTicketIds.has('bdboard-multilabel')).toBe(true);
    expect(result.current.availableLabels).toEqual(['apple', 'frontend', 'zebra']);
    expect(result.current.boardCardsById.has('bdboard-merged')).toBe(true);
    expect(result.current.boardCardsById.has('bdboard-labeled')).toBe(true);
  });

  it('keeps availableLabels as undefined (not []) while board data has not arrived yet', () => {
    fetchBoardMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderBoardData();

    expect(result.current.availableLabels).toBeUndefined();
    expect(result.current.boardTicketIds.size).toBe(0);
    expect(result.current.boardCardsById.size).toBe(0);
  });
});
