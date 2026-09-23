// bdboard-sso1.55: useHygieneRepairActions.ts から、drift/hook 未登録行の
// 「再注入で直す」mutation + ハンドラを move-only で切り出したフック。呼び出し順・
// 依存配列・onMutate/onSuccess/onError の中身は移動前から変えていない。
import { useMutation } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { ProjectHarnessPackStatusDto } from '../../../api';
import { postProjectHarnessInject } from '../../../api';
import type { HarnessBulkUpdateSummary } from '../../../harnessBulkUpdate';
import { buildHarnessInjectSuccessMessage } from '../../../harnessDisplay';
import { describeWriteError } from '../../../writeAccessMessage';
import type { HarnessPackItem } from '../types';
import type { RepairMutationDeps } from './types';

export interface UseHarnessInjectRepairParams extends RepairMutationDeps {
  readonly setBulkUpdateSummary: (
    summary: HarnessBulkUpdateSummary | null,
  ) => void;
  /** handleConfirmHarnessUpdate の二重送信ガードに使う、単票修復側の pending 状態。 */
  readonly repairPending: boolean;
}

export function useHarnessInjectRepair({
  queryClient,
  clearRepairFeedback,
  showRepairStatusMessage,
  setPendingRepairKey,
  setConfirmingRepairKey,
  setRepairError,
  setBulkUpdateSummary,
  repairPending,
}: UseHarnessInjectRepairParams) {
  const harnessInjectMutation = useMutation({
    mutationFn: async (vars: {
      rowKey: string;
      projectId: string;
      pack: ProjectHarnessPackStatusDto;
    }) => {
      await postProjectHarnessInject(vars.projectId, vars.pack.name);
      return vars;
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
      showRepairStatusMessage(
        buildHarnessInjectSuccessMessage(vars.pack.name, vars.pack),
      );
    },
    onError: (error, vars) => {
      setPendingRepairKey(null);
      setRepairError({
        rowKey: vars.rowKey,
        message: describeWriteError(error, 'ハーネスの更新に失敗しました'),
      });
    },
  });

  // drift 行と hook 未登録行はどちらも「再注入で直す」なので同じハンドラを使う。
  const handleConfirmHarnessUpdate = useCallback(
    (item: HarnessPackItem, rowKey: string) => {
      if (repairPending || harnessInjectMutation.isPending) {
        return;
      }
      harnessInjectMutation.mutate({
        rowKey,
        projectId: item.projectId,
        pack: item.pack,
      });
    },
    [harnessInjectMutation, repairPending],
  );

  return { harnessInjectMutation, handleConfirmHarnessUpdate };
}
