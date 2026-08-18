import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchTicket, type BoardCardDto, type TicketDetailDto } from '../api';

export function useWatchedTicketDetails(
  watchedIds: ReadonlySet<string>,
  boardCardsById: ReadonlyMap<string, BoardCardDto>,
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
    })),
  });

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
