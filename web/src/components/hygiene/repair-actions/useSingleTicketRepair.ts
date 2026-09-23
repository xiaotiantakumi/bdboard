// bdboard-sso1.55: useHygieneRepairActions.ts から、単票の修復クイックアクション
// (undefer/close) に関する mutation + ハンドラを move-only で切り出したフック。
// 呼び出し順・依存配列・onMutate/onSuccess/onError の中身は移動前から変えていない。
import { useMutation } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { HygieneIssueDto, QuickActionRequest } from '../../../api';
import { postTicketQuickAction, postTicketQuickActionUndo } from '../../../api';
import { planQuickActionUndo } from '../../../quickActionUndo';
import { describeWriteError } from '../../../writeAccessMessage';
import type { useUndoSnackbar } from '../../UndoSnackbar';
import { buildRepairRequest, buildRepairSuccessMessage } from '../issueDisplay';
import type { RepairMutationDeps } from './types';

export interface UseSingleTicketRepairParams extends RepairMutationDeps {
  readonly undoSnackbar: ReturnType<typeof useUndoSnackbar>;
}

export function useSingleTicketRepair({
  queryClient,
  undoSnackbar,
  clearRepairFeedback,
  showRepairStatusMessage,
  setPendingRepairKey,
  setConfirmingRepairKey,
  setRepairError,
}: UseSingleTicketRepairParams) {
  const repairMutation = useMutation({
    mutationFn: async (vars: {
      rowKey: string;
      ticketId: string;
      request: QuickActionRequest;
      previousDeferUntil?: string;
    }) => {
      await postTicketQuickAction(vars.ticketId, vars.request);
      return vars;
    },
    onMutate: (vars) => {
      setPendingRepairKey(vars.rowKey);
      clearRepairFeedback();
    },
    onSuccess: async (vars) => {
      await queryClient.invalidateQueries({ queryKey: ['hygiene'] });
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setConfirmingRepairKey(null);
      setPendingRepairKey(null);

      showRepairStatusMessage(
        buildRepairSuccessMessage(vars.request, vars.ticketId),
      );

      const plan = planQuickActionUndo(
        vars.request,
        undefined,
        vars.previousDeferUntil,
      );
      if (plan !== null) {
        undoSnackbar?.showUndo({
          message: plan.message,
          onUndo: async () => {
            await postTicketQuickActionUndo(vars.ticketId, plan.undoRequest);
            await queryClient.invalidateQueries({ queryKey: ['hygiene'] });
            await queryClient.invalidateQueries({ queryKey: ['board'] });
          },
        });
      }
    },
    onError: (error, vars) => {
      setPendingRepairKey(null);
      setRepairError({
        rowKey: vars.rowKey,
        message: describeWriteError(error, '修復を実行できませんでした'),
      });
    },
  });

  const handleConfirmRepair = useCallback(
    (issue: HygieneIssueDto, rowKey: string) => {
      if (repairMutation.isPending) {
        return;
      }
      const built = buildRepairRequest(issue);
      if (built === null) {
        return;
      }
      repairMutation.mutate({
        rowKey,
        ticketId: issue.ticketId,
        request: built.request,
        previousDeferUntil: built.previousDeferUntil,
      });
    },
    [repairMutation],
  );

  return { repairMutation, handleConfirmRepair };
}
