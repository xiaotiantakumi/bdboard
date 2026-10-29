// 一括「OK / レビューしました / コメント」。既存のチケット単位 API を順に呼ぶ:
// 確認待ちのチケットには decision answer (freeform)、それ以外にはコメント。
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { postTicketComment, postTicketDecision } from '../../api';
import { runBulkById, type BulkIdOutcome } from '../../bulkQuickAction';
import type { BulkSelectionContextValue } from '../BulkSelectionProvider';

export function useBulkRespond(
  cardsById: ReadonlyMap<string, unknown>,
  pendingDecisionIds: ReadonlySet<string>,
  bulkSelection: BulkSelectionContextValue | null,
  onDone: (outcome: BulkIdOutcome) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const ids = [...(bulkSelection?.selectedIds ?? [])].filter((id) =>
        cardsById.has(id),
      );
      return runBulkById(ids, async (id) => {
        if (pendingDecisionIds.has(id)) {
          await postTicketDecision(id, { freeform: text });
        } else {
          await postTicketComment(id, text);
        }
      });
    },
    onSuccess: async (outcome) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['board'] }),
        queryClient.invalidateQueries({ queryKey: ['pending-decisions'] }),
      ]);
      bulkSelection?.deselectAll(outcome.succeeded);
      onDone(outcome);
    },
  });
}
