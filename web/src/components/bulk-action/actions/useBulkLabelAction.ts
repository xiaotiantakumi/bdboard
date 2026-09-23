// bdboard-sso1.60: useBulkActions.ts から、一括ラベル付与の mutation を
// move-only で切り出したフック。mutationFn/onSuccess の中身は移動前から
// 変えていない。
import { useMutation } from '@tanstack/react-query';
import { postTicketAddLabel } from '../../../api';
import { runBulkById } from '../../../bulkQuickAction';
import type { BulkActionMutationDeps } from './types';

export interface UseBulkLabelActionParams extends BulkActionMutationDeps {
  readonly setBulkLabelInput: (value: string) => void;
}

export function useBulkLabelAction({
  queryClient,
  bulkSelection,
  setLastOutcome,
  setConfirmingAction,
  setBulkLabelInput,
}: UseBulkLabelActionParams) {
  const bulkLabelMutation = useMutation({
    mutationFn: async (vars: { label: string; ids: string[] }) => {
      const outcome = await runBulkById(vars.ids, (id) =>
        postTicketAddLabel(id, vars.label),
      );
      return { label: vars.label, outcome };
    },
    onSuccess: async ({ outcome }) => {
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setLastOutcome(outcome);
      setConfirmingAction(null);
      setBulkLabelInput('');
      bulkSelection?.deselectAll(outcome.succeeded);
    },
  });

  return { bulkLabelMutation };
}
