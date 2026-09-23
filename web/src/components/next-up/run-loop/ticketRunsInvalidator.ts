import type { QueryClient } from '@tanstack/react-query';
import type { TicketRunsChangedListener } from './types';

/** 通知を受けて、そのチケットの実行履歴 (ticket-runs) を stale にするリスナーを作る。 */
export function createTicketRunsInvalidator(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
): TicketRunsChangedListener {
  return (ticketId) => {
    void queryClient.invalidateQueries({ queryKey: ['ticket-runs', ticketId] });
  };
}
