// bdboard-sso1.79: useTicketAgentRun.ts から、エージェント実行の起動 mutation
// (startTicketRun) と中止 mutation (cancelAgentRun) を move-only で切り出した
// フック。mutationFn/onSuccess の中身・queryKey は移動前から変えていない。
// activeRunId や confirmingAgentRun 等の state 自体は複数の下位フック (親の
// reset・ポーリング等) から参照されるため親に残し、setter/値を引数で受け取る。
import type { QueryClient } from '@tanstack/react-query';
import { useMutation } from '@tanstack/react-query';
import { cancelAgentRun, startTicketRun } from '../../../api';

export function useAgentRunMutations(
  ticketId: string,
  queryClient: QueryClient,
  activeRunId: string | null,
  setConfirmingAgentRun: (value: boolean) => void,
  setActiveRunId: (value: string | null) => void,
  setActiveRunMeta: (
    value: { worktreePath: string; branchName: string; reused: boolean } | null,
  ) => void,
) {
  const startRunMutation = useMutation({
    mutationFn: () => startTicketRun(ticketId),
    onSuccess: (response) => {
      setConfirmingAgentRun(false);
      setActiveRunId(response.runId);
      setActiveRunMeta({
        worktreePath: response.worktreePath,
        branchName: response.branchName,
        reused: response.reused,
      });
      void queryClient.invalidateQueries({ queryKey: ['ticket-runs', ticketId] });
      // 一括実行 (bdboard-xuuz) の「既に実行中のエージェントがあるカード」判定が使う
      // 盤面全体の run 一覧も、この画面から実行を始めた瞬間に stale にする — でないと
      // 同じセッションで直後に一括実行を開こうとしたとき、既定の staleTime (30秒) の間
      // このチケットが「実行中」に見えず、サーバー側の 409 already-running で
      // 一括実行が失敗扱いになる (ticketRunsInvalidator.ts と同じ理由)。
      void queryClient.invalidateQueries({ queryKey: ['agent-runs-active'] });
    },
  });

  const cancelRunMutation = useMutation({
    mutationFn: async () => {
      if (activeRunId === null) {
        throw new Error('active run is not available');
      }
      await cancelAgentRun(activeRunId);
    },
  });

  return { startRunMutation, cancelRunMutation };
}
