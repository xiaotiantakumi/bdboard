import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteTicketDependency,
  postTicketDependency,
  searchTickets,
  type TicketSearchResultDto,
} from '../../api';
import { useTicketDependencies } from './useTicketDependencies';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    postTicketDependency: vi.fn(),
    deleteTicketDependency: vi.fn(),
    searchTickets: vi.fn(),
  };
});

const postTicketDependencyMock = vi.mocked(postTicketDependency);
const deleteTicketDependencyMock = vi.mocked(deleteTicketDependency);
const searchTicketsMock = vi.mocked(searchTickets);

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const baseData = {
  id: 'bd-1',
  projectId: 'proj-1',
  dependencies: [{ dependsOnId: 'bd-2' }],
};

function candidate(id: string, title = 'title'): TicketSearchResultDto {
  return {
    id,
    title,
    projectId: 'proj-1',
  } as TicketSearchResultDto;
}

describe('useTicketDependencies', () => {
  beforeEach(() => {
    postTicketDependencyMock.mockReset();
    deleteTicketDependencyMock.mockReset();
    searchTicketsMock.mockReset();
    postTicketDependencyMock.mockResolvedValue(undefined);
    deleteTicketDependencyMock.mockResolvedValue(undefined);
    searchTicketsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    // fake timer を使うテストが assertion 失敗で早期リターンした場合でも、
    // 後続テストへ fake timer 状態が漏れないようにする。
    vi.useRealTimers();
  });

  it('does nothing when the search query is empty', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDependencies('bd-1', baseData),
      { wrapper: createWrapper(queryClient) },
    );

    expect(result.current.hasDependencySearchQuery).toBe(false);
    expect(result.current.dependencyCandidates).toEqual([]);
    expect(searchTicketsMock).not.toHaveBeenCalled();
  });

  it('debounces the search, filters existing/self/other-project hits, and surfaces results', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    searchTicketsMock.mockResolvedValue([
      candidate('bd-2'), // already a dependency -> filtered
      candidate('bd-1'), // self -> filtered
      { ...candidate('bd-9'), projectId: 'other-proj' }, // other project -> filtered
      candidate('bd-3'),
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDependencies('bd-1', baseData),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setDependencySearchQuery('bd');
    });
    expect(result.current.hasDependencySearchQuery).toBe(true);
    expect(result.current.dependencySearchLoading).toBe(true);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();

    expect(result.current.dependencyCandidates).toEqual([candidate('bd-3')]);
    expect(result.current.dependencySearchLoading).toBe(false);
  });

  it('surfaces a search error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    searchTicketsMock.mockRejectedValue(new Error('search failed'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDependencies('bd-1', baseData),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setDependencySearchQuery('bd');
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();

    expect(result.current.dependencySearchError?.message).toBe('search failed');
    expect(result.current.dependencyCandidates).toEqual([]);
  });

  it('adds a dependency and clears the search query on success', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDependencies('bd-1', baseData),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setDependencySearchQuery('bd-3');
    });
    await act(async () => {
      result.current.handleAddDependency('bd-3');
    });

    await waitFor(() =>
      expect(postTicketDependencyMock).toHaveBeenCalledWith('bd-1', 'bd-3'),
    );
    await waitFor(() => expect(result.current.dependencySearchQuery).toBe(''));
  });

  it('removes a dependency via handleRemoveDependency', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDependencies('bd-1', baseData),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.handleRemoveDependency('bd-2');
    });

    await waitFor(() =>
      expect(deleteTicketDependencyMock).toHaveBeenCalledWith('bd-1', 'bd-2'),
    );
  });

  it('surfaces an error from either mutation and keeps dependencyMutationPending combined', async () => {
    postTicketDependencyMock.mockRejectedValue(new Error('network down'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDependencies('bd-1', baseData),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.handleAddDependency('bd-3');
    });

    await waitFor(() => expect(result.current.error).not.toBe(null));
    expect(result.current.dependencyMutationPending).toBe(false);
  });

  it('reset() clears search query, candidates, loading, and error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    searchTicketsMock.mockRejectedValue(new Error('search failed'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useTicketDependencies('bd-1', baseData),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setDependencySearchQuery('bd');
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();
    expect(result.current.dependencySearchError).not.toBe(null);

    act(() => {
      result.current.reset();
    });

    expect(result.current.dependencySearchQuery).toBe('');
    expect(result.current.dependencyCandidates).toEqual([]);
    expect(result.current.dependencySearchLoading).toBe(false);
    expect(result.current.dependencySearchError).toBe(null);
  });
});
