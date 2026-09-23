// bdboard-sso1.79: useTicketAgentRun.ts から、チケットの実行履歴一覧クエリを
// move-only で切り出したフック。queryKey・queryFn は移動前から変えていない。
// このクエリから進行中の run を拾う activeRunFromList の算出は、
// 「ticketId 変更リセット effect」より後の宣言順序を保つため親に残している
// (ファイル冒頭の解説コメント参照)。
import { useQuery } from '@tanstack/react-query';
import { fetchTicketRuns } from '../../../api';

export function useTicketRunsQuery(ticketId: string) {
  const {
    data: ticketRunsData,
    isLoading: ticketRunsLoading,
    error: ticketRunsError,
  } = useQuery({
    queryKey: ['ticket-runs', ticketId],
    queryFn: () => fetchTicketRuns(ticketId),
  });

  return { ticketRunsData, ticketRunsLoading, ticketRunsError };
}
