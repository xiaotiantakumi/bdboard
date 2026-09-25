import type { QueryClient } from '@tanstack/react-query';
import type { TicketRunsChangedListener } from './types';

/**
 * 通知を受けて、そのチケットの実行履歴 (ticket-runs) を stale にするリスナーを作る。
 * あわせて一括実行 (bdboard-xuuz) の「既に実行中のエージェントがあるカード」判定が
 * 使う盤面全体の run 一覧 (agent-runs-active) も stale にする — この listener は
 * Next Up ループの開始結果と終了のたびに呼ばれるので、そのタイミングが
 * agent-runs-active にとっても「実行が始まった/終わった」瞬間そのものになる。
 */
export function createTicketRunsInvalidator(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
): TicketRunsChangedListener {
  return (ticketId) => {
    void queryClient.invalidateQueries({ queryKey: ['ticket-runs', ticketId] });
    void queryClient.invalidateQueries({ queryKey: ['agent-runs-active'] });
  };
}
