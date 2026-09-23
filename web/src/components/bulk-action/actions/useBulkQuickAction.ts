// bdboard-sso1.60: useBulkActions.ts から、一括クイックアクション
// (close/defer/priority-up/priority-down) の mutation を move-only で
// 切り出したフック。mutationFn/onSuccess の中身、Undo スナックバー連携の
// クロージャは移動前から変えていない。
import { useMutation } from '@tanstack/react-query';
import {
  postTicketQuickAction,
  postTicketQuickActionUndo,
} from '../../../api';
import {
  type BulkQuickActionTarget,
  runBulkQuickAction,
} from '../../../bulkQuickAction';
import { DEFAULT_DEFER_PERIOD, type DeferPeriodKind } from '../../../deferPeriods';
import { planQuickActionUndo } from '../../../quickActionUndo';
import type { useUndoSnackbar } from '../../UndoSnackbar';
import { bulkSuccessMessage } from '../messages';
import type { BulkConfirmingAction } from '../types';
import type { BulkActionMutationDeps } from './types';

export interface UseBulkQuickActionParams extends BulkActionMutationDeps {
  readonly undoSnackbar: ReturnType<typeof useUndoSnackbar>;
  readonly setDeferPeriodKind: (kind: DeferPeriodKind) => void;
  readonly setCustomDeferDate: (value: string) => void;
  readonly setCloseReason: (value: string) => void;
}

export function useBulkQuickAction({
  queryClient,
  bulkSelection,
  undoSnackbar,
  setLastOutcome,
  setConfirmingAction,
  setDeferPeriodKind,
  setCustomDeferDate,
  setCloseReason,
}: UseBulkQuickActionParams) {
  const bulkMutation = useMutation({
    mutationFn: async (vars: {
      action: BulkConfirmingAction;
      targets: BulkQuickActionTarget[];
    }) => {
      const outcome = await runBulkQuickAction(
        vars.targets,
        postTicketQuickAction,
      );
      return { action: vars.action, outcome };
    },
    onSuccess: async ({ action, outcome }) => {
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setLastOutcome(outcome);
      setConfirmingAction(null);
      setDeferPeriodKind(DEFAULT_DEFER_PERIOD);
      setCustomDeferDate('');
      setCloseReason('');
      bulkSelection?.deselectAll(outcome.succeeded.map((target) => target.id));

      if (outcome.succeeded.length > 0 && undoSnackbar !== null) {
        const succeeded = outcome.succeeded;
        undoSnackbar.showUndo({
          message: bulkSuccessMessage(action, succeeded.length),
          onUndo: async () => {
            const undoFailedIds: string[] = [];
            let undoSucceededCount = 0;
            for (const target of succeeded) {
              const plan = planQuickActionUndo(
                target.request,
                target.previousPriority,
              );
              if (plan === null) {
                continue;
              }
              try {
                await postTicketQuickActionUndo(target.id, plan.undoRequest);
                undoSucceededCount += 1;
              } catch {
                undoFailedIds.push(target.id);
              }
            }
            await queryClient.invalidateQueries({ queryKey: ['board'] });
            if (undoFailedIds.length > 0) {
              throw new Error(
                `${undoSucceededCount}件中${undoFailedIds.length}件は元に戻せませんでした（対象: ${undoFailedIds.join(', ')}）`,
              );
            }
          },
        });
      }
    },
  });

  return { bulkMutation };
}
