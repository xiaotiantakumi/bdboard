import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import {
  ApiError,
  fetchTicket,
  type BoardCardDto,
  type TicketDetailDto,
} from '../api';

function shouldRetryWatchedTicket(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status === 404) {
    return false;
  }
  return failureCount < 3;
}

export function useWatchedTicketDetails(
  watchedIds: ReadonlySet<string>,
  boardCardsById: ReadonlyMap<string, BoardCardDto>,
  onTicketNotFound?: (ticketId: string) => void,
): ReadonlyMap<string, TicketDetailDto> {
  const offBoardIds = useMemo(
    () => [...watchedIds].filter((ticketId) => !boardCardsById.has(ticketId)),
    [watchedIds, boardCardsById],
  );

  const queries = useQueries({
    queries: offBoardIds.map((ticketId) => ({
      queryKey: ['ticket', ticketId],
      queryFn: () => fetchTicket(ticketId),
      staleTime: 30_000,
      retry: shouldRetryWatchedTicket,
    })),
  });

  useEffect(() => {
    if (onTicketNotFound === undefined) {
      return;
    }
    for (let index = 0; index < offBoardIds.length; index += 1) {
      const ticketId = offBoardIds[index]!;
      const error = queries[index]?.error;
      if (error instanceof ApiError && error.status === 404) {
        onTicketNotFound(ticketId);
      }
    }
  }, [offBoardIds, queries, onTicketNotFound]);

  return useMemo(() => {
    const map = new Map<string, TicketDetailDto>();
    for (let index = 0; index < offBoardIds.length; index += 1) {
      const ticketId = offBoardIds[index]!;
      const data = queries[index]?.data;
      if (data !== undefined) {
        map.set(ticketId, data);
      }
    }
    return map;
  }, [offBoardIds, queries]);
}
