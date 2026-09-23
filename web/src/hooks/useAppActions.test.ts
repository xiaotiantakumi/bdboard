import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDto } from '../api';
import { useAppActions, type AppActionsParams } from './useAppActions';

type RefetchableQueryParam = AppActionsParams['boardQuery'];

function makeQuery(overrides: {
  isFetching?: boolean;
  refetch?: RefetchableQueryParam['refetch'];
} = {}): RefetchableQueryParam {
  return {
    isFetching: overrides.isFetching ?? false,
    refetch:
      overrides.refetch ??
      (vi.fn().mockResolvedValue(undefined) as unknown as RefetchableQueryParam['refetch']),
  };
}

function makeProject(id: string, name = id): ProjectDto {
  return {
    id,
    name,
    rootPath: `/projects/${id}`,
    prefixes: [],
    sessionCount: 0,
    activeSessionCount: 0,
    incompleteTicketCount: 0,
    sessions: [],
  };
}

function baseParams(overrides: Partial<AppActionsParams> = {}): AppActionsParams {
  return {
    setRecentTickets: vi.fn(),
    projectNames: new Map([['proj-1', 'Project One']]),
    boardTicketIds: new Set(['ticket-on-board']),
    boardQuery: makeQuery(),
    statusQuery: makeQuery(),
    reconnect: vi.fn(),
    setSelectedProjectIds: vi.fn(),
    projectsQuery: { data: [makeProject('proj-1'), makeProject('proj-2')] },
    setView: vi.fn(),
    handleOpenChat: vi.fn(),
    setHideDone: vi.fn(),
    hideDone: true,
    setStalledOnly: vi.fn(),
    stalledOnly: false,
    handleOpenSessionList: vi.fn(),
    handleOpenHelp: vi.fn(),
    chatAvailable: true,
    setEpicFilterId: vi.fn(),
    handleCloseDetail: vi.fn(),
    epicFilterId: undefined,
    view: 'merged',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAppActions', () => {
  it('handleRecordRecentTicket records the entry with the project name resolved from projectNames', () => {
    const params = baseParams();
    const { result } = renderHook(() => useAppActions(params));

    result.current.handleRecordRecentTicket({
      id: 'ticket-marker-1',
      title: 'Marker Title',
      projectId: 'proj-1',
    });

    expect(vi.mocked(params.setRecentTickets).mock.calls.at(-1)).toBeDefined();
    const updater = vi.mocked(params.setRecentTickets).mock.calls.at(-1)?.[0] as (
      current: unknown[],
    ) => unknown[];
    const next = updater([]);
    expect(next).toEqual([
      { id: 'ticket-marker-1', title: 'Marker Title', projectName: 'Project One' },
    ]);
  });

  it('handleRecordRecentTicket falls back to the raw projectId when the name is unknown', () => {
    const params = baseParams({ projectNames: new Map() });
    const { result } = renderHook(() => useAppActions(params));

    result.current.handleRecordRecentTicket({
      id: 'ticket-marker-2',
      title: 'Marker Title 2',
      projectId: 'proj-unknown',
    });

    const updater = vi.mocked(params.setRecentTickets).mock.calls.at(-1)?.[0] as (
      current: unknown[],
    ) => unknown[];
    const next = updater([]);
    expect(next).toEqual([
      { id: 'ticket-marker-2', title: 'Marker Title 2', projectName: 'proj-unknown' },
    ]);
  });

  it('isTicketOnBoard reflects boardTicketIds membership', () => {
    const params = baseParams();
    const { result } = renderHook(() => useAppActions(params));

    expect(result.current.isTicketOnBoard('ticket-on-board')).toBe(true);
    expect(result.current.isTicketOnBoard('ticket-not-on-board')).toBe(false);
  });

  it.each([
    ['board query fetching', { boardQuery: makeQuery({ isFetching: true }) }],
    ['status query fetching', { statusQuery: makeQuery({ isFetching: true }) }],
  ] as const)('isRefreshing is true while %s', (_name, overrides) => {
    const params = baseParams(overrides);
    const { result } = renderHook(() => useAppActions(params));

    expect(result.current.isRefreshing).toBe(true);
  });

  it('isRefreshing is false when neither query is fetching', () => {
    const params = baseParams();
    const { result } = renderHook(() => useAppActions(params));

    expect(result.current.isRefreshing).toBe(false);
  });

  it('handleRefresh refetches board, refetches status, and reconnects', () => {
    const refetchBoard = vi.fn().mockResolvedValue(undefined);
    const refetchStatus = vi.fn().mockResolvedValue(undefined);
    const params = baseParams({
      boardQuery: makeQuery({
        refetch: refetchBoard as unknown as RefetchableQueryParam['refetch'],
      }),
      statusQuery: makeQuery({
        refetch: refetchStatus as unknown as RefetchableQueryParam['refetch'],
      }),
    });
    const { result } = renderHook(() => useAppActions(params));

    result.current.handleRefresh();

    expect(refetchBoard).toHaveBeenCalledTimes(1);
    expect(refetchStatus).toHaveBeenCalledTimes(1);
    expect(params.reconnect).toHaveBeenCalledTimes(1);
  });

  describe('handleToggleProject', () => {
    it('adds the project id when checked and not already selected', () => {
      const params = baseParams();
      const { result } = renderHook(() => useAppActions(params));

      result.current.handleToggleProject('proj-marker-new', true);

      const updater = vi.mocked(params.setSelectedProjectIds).mock.calls.at(-1)?.[0] as (
        current: string[],
      ) => string[];
      expect(updater(['proj-existing'])).toEqual(['proj-existing', 'proj-marker-new']);
    });

    it('does not duplicate an id that is already selected', () => {
      const params = baseParams();
      const { result } = renderHook(() => useAppActions(params));

      result.current.handleToggleProject('proj-existing', true);

      const updater = vi.mocked(params.setSelectedProjectIds).mock.calls.at(-1)?.[0] as (
        current: string[],
      ) => string[];
      expect(updater(['proj-existing'])).toEqual(['proj-existing']);
    });

    it('removes the project id when unchecked', () => {
      const params = baseParams();
      const { result } = renderHook(() => useAppActions(params));

      result.current.handleToggleProject('proj-marker-remove', false);

      const updater = vi.mocked(params.setSelectedProjectIds).mock.calls.at(-1)?.[0] as (
        current: string[],
      ) => string[];
      expect(updater(['proj-keep', 'proj-marker-remove'])).toEqual(['proj-keep']);
    });
  });

  it('handleSelectAll selects every id currently in projectsQuery.data', () => {
    const params = baseParams({
      projectsQuery: { data: [makeProject('proj-marker-a'), makeProject('proj-marker-b')] },
    });
    const { result } = renderHook(() => useAppActions(params));

    result.current.handleSelectAll();

    expect(vi.mocked(params.setSelectedProjectIds).mock.calls.at(-1)).toEqual([
      ['proj-marker-a', 'proj-marker-b'],
    ]);
  });

  it('handleSelectAll selects nothing when projectsQuery.data is undefined', () => {
    const params = baseParams({ projectsQuery: { data: undefined } });
    const { result } = renderHook(() => useAppActions(params));

    result.current.handleSelectAll();

    expect(vi.mocked(params.setSelectedProjectIds).mock.calls.at(-1)).toEqual([[]]);
  });

  it('handleClearAll clears the selection', () => {
    const params = baseParams();
    const { result } = renderHook(() => useAppActions(params));

    result.current.handleClearAll();

    expect(vi.mocked(params.setSelectedProjectIds).mock.calls.at(-1)).toEqual([[]]);
  });

  it('paletteActions wires onRefresh through to the handleRefresh built by this same hook', () => {
    const refetchBoard = vi.fn().mockResolvedValue(undefined);
    const params = baseParams({
      boardQuery: makeQuery({ refetch: refetchBoard as unknown as RefetchableQueryParam['refetch'] }),
    });
    const { result } = renderHook(() => useAppActions(params));

    const refreshAction = result.current.paletteActions.find((a) => a.id === 'other:refresh');
    expect(refreshAction).toBeDefined();
    refreshAction?.onSelect();

    expect(refetchBoard).toHaveBeenCalledTimes(1);
    expect(params.reconnect).toHaveBeenCalledTimes(1);
  });

  it('paletteActions includes a chat action only when chatAvailable is true', () => {
    const availableParams = baseParams({ chatAvailable: true });
    const { result: available } = renderHook(() => useAppActions(availableParams));
    expect(available.current.paletteActions.some((a) => a.id === 'panel:chat')).toBe(true);

    const unavailableParams = baseParams({ chatAvailable: false });
    const { result: unavailable } = renderHook(() => useAppActions(unavailableParams));
    expect(unavailable.current.paletteActions.some((a) => a.id === 'panel:chat')).toBe(false);
  });

  describe('handleFilterByEpic', () => {
    it('sets the epic filter id and closes the detail panel', () => {
      const params = baseParams();
      const { result } = renderHook(() => useAppActions(params));

      result.current.handleFilterByEpic('epic-marker-1');

      expect(params.setEpicFilterId).toHaveBeenCalledWith('epic-marker-1');
      expect(params.handleCloseDetail).toHaveBeenCalledTimes(1);
    });
  });

  describe('epicFilterId view-switch effect', () => {
    it('does nothing when epicFilterId is undefined', () => {
      const params = baseParams({ epicFilterId: undefined, view: 'activity' });
      renderHook(() => useAppActions(params));

      expect(params.setView).not.toHaveBeenCalled();
    });

    it.each(['merged', 'split', 'next'] as const)(
      'does not force a view switch when epicFilterId is set and the current view (%s) can already show the filtered board',
      (view) => {
        const params = baseParams({ epicFilterId: 'epic-1', view });
        renderHook(() => useAppActions(params));

        expect(params.setView).not.toHaveBeenCalled();
      },
    );

    it.each(['activity', 'digest', 'stats', 'hygiene', 'graph'] as const)(
      'forces a switch to merged when epicFilterId is set and the current view (%s) cannot show the filtered board',
      (view) => {
        const params = baseParams({ epicFilterId: 'epic-1', view });
        renderHook(() => useAppActions(params));

        expect(params.setView).toHaveBeenCalledWith('merged');
      },
    );

    it('re-subscribes to the latest view on rerender (pins the epicFilterId-only dependency array)', () => {
      // epicFilterId 切り替え effect は「epicFilterId が変わった回」だけ発火する
      // 設計(view の変化では再発火しない)。この rerender で view を
      // 'activity' に変えても、epicFilterId 自体は変わっていないので
      // setView は呼ばれない。
      const params = baseParams({ epicFilterId: undefined, view: 'merged' });
      const { rerender } = renderHook(
        (p: AppActionsParams) => useAppActions(p),
        { initialProps: params },
      );
      expect(params.setView).not.toHaveBeenCalled();

      rerender({ ...params, view: 'activity' });
      expect(params.setView).not.toHaveBeenCalled();

      rerender({ ...params, view: 'activity', epicFilterId: 'epic-2' });
      expect(params.setView).toHaveBeenCalledWith('merged');
    });
  });
});
