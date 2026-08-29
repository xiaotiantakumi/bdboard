import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type TicketDetailDto } from '../api';
import { useWatchedTicketDetails } from './useWatchedTicketDetails';

const fetchTicket = vi.fn<(id: string) => Promise<TicketDetailDto>>();

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  fetchTicket: (id: string) => fetchTicket(id),
}));

const LOST_TICKET_ID = 'bdboard-lost-1';

const mockTicketDetail: TicketDetailDto = {
  id: LOST_TICKET_ID,
  projectId: 'proj-1',
  title: 'Lost ticket',
  status: 'open',
  priority: 2,
  issueType: 'task',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  commentCount: 0,
  dependencies: [],
  blockedBy: [],
  blocks: [],
  sessionLinks: [],
  models: [],
  children: [],
};

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useWatchedTicketDetails', () => {
  beforeEach(() => {
    fetchTicket.mockReset();
  });

  it('stores fetched ticket details in the returned map', async () => {
    fetchTicket.mockResolvedValue(mockTicketDetail);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const watchedIds = new Set([LOST_TICKET_ID]);
    const boardCardsById = new Map<string, never>();

    const { result } = renderHook(
      () => useWatchedTicketDetails(watchedIds, boardCardsById),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.get(LOST_TICKET_ID)).toEqual(mockTicketDetail);
    });
  });

  it('calls onTicketNotFound when fetchTicket rejects with ApiError 404', async () => {
    fetchTicket.mockRejectedValue(new ApiError(404, 'Not found'));

    const queryClient = new QueryClient();
    const onTicketNotFound = vi.fn();
    const watchedIds = new Set([LOST_TICKET_ID]);
    const boardCardsById = new Map<string, never>();

    renderHook(
      () => useWatchedTicketDetails(watchedIds, boardCardsById, onTicketNotFound),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(onTicketNotFound).toHaveBeenCalledWith(LOST_TICKET_ID);
    });
  });

  it('does not retry fetchTicket when ApiError status is 404', async () => {
    fetchTicket.mockRejectedValue(new ApiError(404, 'Not found'));

    const queryClient = new QueryClient();
    const watchedIds = new Set([LOST_TICKET_ID]);
    const boardCardsById = new Map<string, never>();

    renderHook(
      () => useWatchedTicketDetails(watchedIds, boardCardsById),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(fetchTicket).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(fetchTicket).toHaveBeenCalledTimes(1);
    }, { timeout: 500 });
  });

  it('does not call onTicketNotFound for ApiError 500', async () => {
    fetchTicket.mockRejectedValue(new ApiError(500, 'Server error'));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onTicketNotFound = vi.fn();
    const watchedIds = new Set([LOST_TICKET_ID]);
    const boardCardsById = new Map<string, never>();

    renderHook(
      () => useWatchedTicketDetails(watchedIds, boardCardsById, onTicketNotFound),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(fetchTicket).toHaveBeenCalled();
    });

    expect(onTicketNotFound).not.toHaveBeenCalled();
  });

  it('does not call onTicketNotFound for a plain Error', async () => {
    fetchTicket.mockRejectedValue(new Error('network down'));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onTicketNotFound = vi.fn();
    const watchedIds = new Set([LOST_TICKET_ID]);
    const boardCardsById = new Map<string, never>();

    renderHook(
      () => useWatchedTicketDetails(watchedIds, boardCardsById, onTicketNotFound),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(fetchTicket).toHaveBeenCalled();
    });

    expect(onTicketNotFound).not.toHaveBeenCalled();
  });
});
