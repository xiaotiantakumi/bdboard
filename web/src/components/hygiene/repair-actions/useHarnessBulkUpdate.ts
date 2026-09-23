// bdboard-sso1.55: useHygieneRepairActions.ts から、ハーネス一括更新の確認〜実行〜
// 結果表示に関する mutation + state + ハンドラ + フォーカス effect を move-only で
// 切り出したフック。呼び出し順・依存配列・effect の順序とクリーンアップは移動前から
// 変えていない (元々クリーンアップ関数は無い)。bulkUpdateTargets/bulkUpdateSummary の
// state 自体は、単体修復系のフック (useHarnessInjectRepair/useContractTicketRepair) の
// onSuccess からも「古い一括結果を残さない」ために触られる共有 state のため、親
// (useHygieneRepairActions) 側に残し、ここへは値とセッターを引数で渡す。
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { postProjectHarnessInject } from '../../../api';
import {
  buildHarnessBulkSummaryMessage,
  runHarnessBulkUpdate,
  type HarnessBulkUpdateSummary,
  type HarnessBulkUpdateTarget,
} from '../../../harnessBulkUpdate';
import type { HarnessPackItem } from '../types';

export interface UseHarnessBulkUpdateParams {
  readonly queryClient: QueryClient;
  readonly clearRepairFeedback: () => void;
  readonly showRepairStatusMessage: (message: string) => void;
  readonly setConfirmingRepairKey: (rowKey: string | null) => void;
  readonly bulkUpdateTargets: readonly HarnessBulkUpdateTarget[] | null;
  readonly setBulkUpdateTargets: (
    targets: readonly HarnessBulkUpdateTarget[] | null,
  ) => void;
  readonly setBulkUpdateSummary: (
    summary: HarnessBulkUpdateSummary | null,
  ) => void;
}

export function useHarnessBulkUpdate({
  queryClient,
  clearRepairFeedback,
  showRepairStatusMessage,
  setConfirmingRepairKey,
  bulkUpdateTargets,
  setBulkUpdateTargets,
  setBulkUpdateSummary,
}: UseHarnessBulkUpdateParams) {
  const harnessBulkUpdateMutation = useMutation({
    mutationFn: (targets: readonly HarnessBulkUpdateTarget[]) =>
      runHarnessBulkUpdate(targets, (target) =>
        postProjectHarnessInject(target.projectId, target.packName),
      ),
    onMutate: () => {
      setBulkUpdateSummary(null);
      clearRepairFeedback();
    },
    onSuccess: async (summary) => {
      await queryClient.invalidateQueries({ queryKey: ['project-harness'] });
      await queryClient.invalidateQueries({ queryKey: ['harness-drift'] });
      await queryClient.invalidateQueries({ queryKey: ['harness-status-all'] });
      setBulkUpdateTargets(null);
      setBulkUpdateSummary(summary);
      // 件数は常駐の aria-live に流す (後から挿入された role=status は読まれにくい)。
      showRepairStatusMessage(buildHarnessBulkSummaryMessage(summary));
    },
  });

  const beginBulkUpdateConfirm = useCallback(
    (items: readonly HarnessPackItem[]) => {
      setBulkUpdateSummary(null);
      setConfirmingRepairKey(null);
      clearRepairFeedback();
      setBulkUpdateTargets(
        items.map(({ projectId, pack }) => ({
          projectId,
          packName: pack.name,
          installedVersion: pack.installedVersion,
          availableVersion: pack.availableVersion,
        })),
      );
    },
    [clearRepairFeedback],
  );

  const confirmBulkUpdate = useCallback(() => {
    if (bulkUpdateTargets !== null && !harnessBulkUpdateMutation.isPending) {
      harnessBulkUpdateMutation.mutate(bulkUpdateTargets);
    }
  }, [bulkUpdateTargets, harnessBulkUpdateMutation]);

  // 確認欄を開いたら確定ボタンへフォーカスを移す (トリガーのボタンはアンマウントされる)。
  const bulkConfirmButtonRef = useRef<HTMLButtonElement>(null);
  const isBulkConfirming = bulkUpdateTargets !== null;
  useEffect(() => {
    if (isBulkConfirming) {
      bulkConfirmButtonRef.current?.focus();
    }
  }, [isBulkConfirming]);

  const cancelBulkUpdateTargets = useCallback(() => {
    setBulkUpdateTargets(null);
  }, []);

  const closeBulkUpdateSummary = useCallback(() => {
    setBulkUpdateSummary(null);
  }, []);

  return {
    harnessBulkUpdateMutation,
    beginBulkUpdateConfirm,
    confirmBulkUpdate,
    cancelBulkUpdateTargets,
    closeBulkUpdateSummary,
    bulkConfirmButtonRef,
  };
}
