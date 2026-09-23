// bdboard-sso1.55: useHygieneRepairActions.ts から、検証コントラクト不足を直す
// チケット起票の mutation + ハンドラを move-only で切り出したフック。呼び出し順・
// 依存配列・onMutate/onSuccess/onError の中身は移動前から変えていない。
import { useMutation } from '@tanstack/react-query';
import { useCallback } from 'react';
import { postProjectHarnessContractTicket } from '../../../api';
import type { HarnessBulkUpdateSummary } from '../../../harnessBulkUpdate';
import { buildHarnessContractTicketSuccessMessage } from '../../../harnessDisplay';
import { describeWriteError } from '../../../writeAccessMessage';
import type { HarnessContractItem } from '../types';
import type { RepairMutationDeps } from './types';

export interface UseContractTicketRepairParams extends RepairMutationDeps {
  readonly setBulkUpdateSummary: (
    summary: HarnessBulkUpdateSummary | null,
  ) => void;
}

export function useContractTicketRepair({
  queryClient,
  clearRepairFeedback,
  showRepairStatusMessage,
  setPendingRepairKey,
  setConfirmingRepairKey,
  setRepairError,
  setBulkUpdateSummary,
}: UseContractTicketRepairParams) {
  /**
   * 検証コントラクト不足を直すチケット起票 (bdboard-p5l.25)。drift/hooks の
   * 「再注入で直す」とは違い、bd 側にチケットを立てるだけ (ファイルは書き換えない)。
   * 冪等性 (既存の harness-contract ラベル付き未クローズチケットがあれば新規作成しない)
   * はサーバー側 (fileHarnessContractTicket) の責務 — ここは結果の created で
   * 文言を出し分けるだけ。
   */
  const contractTicketMutation = useMutation({
    mutationFn: async (vars: { rowKey: string; projectId: string }) => {
      const result = await postProjectHarnessContractTicket(vars.projectId);
      return { ...vars, result };
    },
    onMutate: (vars) => {
      setPendingRepairKey(vars.rowKey);
      clearRepairFeedback();
    },
    onSuccess: async (vars) => {
      await queryClient.invalidateQueries({ queryKey: ['harness-drift'] });
      await queryClient.invalidateQueries({
        queryKey: ['project-harness', vars.projectId],
      });
      setConfirmingRepairKey(null);
      setPendingRepairKey(null);
      // 単体で直した後に古い一括結果 (「失敗」行など) を残さない。
      setBulkUpdateSummary(null);
      // bdboard-13mp: state 遷移をまたいだ陳腐化チケットの扱い — 文言に使う contract は
      // クリック時点でこのコンポーネントがポーリングでキャッシュしていた item.contract
      // ではなく、サーバーがこのリクエストで実際に読んだ vars.result.contract を使う
      // (レビュー指摘)。ポーリングキャッシュとの間には、最後のポーリングからクリック
      // までの間に契約ファイルが変わっている可能性がある窓があり、それをそのまま
      // 使うと「追記した」と言いながら別の (古い) 状態名を出しかねない — まさに
      // この機能が直そうとしている陳腐化表示をクライアント側で再発させてしまう。
      showRepairStatusMessage(
        buildHarnessContractTicketSuccessMessage(
          vars.result.ticketId,
          vars.result.created,
          vars.result.stateAppend,
          vars.result.contract,
        ),
      );
    },
    onError: (error, vars) => {
      setPendingRepairKey(null);
      setRepairError({
        rowKey: vars.rowKey,
        message: describeWriteError(error, 'チケットの起票に失敗しました'),
      });
    },
  });

  const handleConfirmContractTicket = useCallback(
    (item: HarnessContractItem, rowKey: string) => {
      if (contractTicketMutation.isPending) {
        return;
      }
      contractTicketMutation.mutate({ rowKey, projectId: item.projectId });
    },
    [contractTicketMutation],
  );

  return { contractTicketMutation, handleConfirmContractTicket };
}
