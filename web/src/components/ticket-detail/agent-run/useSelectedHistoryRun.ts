// bdboard-sso1.79: useTicketAgentRun.ts から、実行履歴で選択された run の詳細
// クエリを move-only で切り出したフック。queryKey・queryFn・enabled は移動前
// から変えていない。selectedHistoryRunId の state 自体は reset() からも
// setSelectedHistoryRunId 経由で書き換えられるため親に残し、引数で受け取る。
import { useQuery } from '@tanstack/react-query';
import { fetchAgentRun } from '../../../api';

export function useSelectedHistoryRun(selectedHistoryRunId: string | null) {
  const {
    data: selectedHistoryRun,
    isLoading: selectedHistoryRunLoading,
    error: selectedHistoryRunError,
  } = useQuery({
    queryKey: ['agent-run', selectedHistoryRunId],
    queryFn: () => fetchAgentRun(selectedHistoryRunId!),
    enabled: selectedHistoryRunId !== null,
  });

  return { selectedHistoryRun, selectedHistoryRunLoading, selectedHistoryRunError };
}
