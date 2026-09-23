// bdboard-sso1.65: useBulkActions.ts (親フック) から、確認パネルの実行ボタン
// (BulkActionConfirmPanel の onConfirm) 1本に対する kind ごとの分岐処理
// (handleConfirm) をカスタムフックへ切り出した。mutationFn/onSuccess 側は
// useBulkQuickAction.ts/useBulkLabelAction.ts (#623) に残ったまま変えておらず、
// ここが呼ぶのはそれぞれの `.mutate(...)` だけ。分岐のロジック自体
// (add-label なら useBulkLabelAction、それ以外は useBulkQuickAction) は
// 分割前から1文字も変えていない。
import { useCallback } from 'react';
import type { BoardCardDto } from '../../../api';
import type { useBulkLabelAction } from '../actions/useBulkLabelAction';
import type { useBulkQuickAction } from '../actions/useBulkQuickAction';
import { buildTargetsForAction, filterIdsPresentOnBoard } from '../targets';
import type { BulkConfirmingAction } from '../types';

export interface UseBulkConfirmDispatchParams {
  readonly confirmingAction: BulkConfirmingAction | null;
  readonly selectedIds: ReadonlySet<string>;
  readonly cardsById: ReadonlyMap<string, BoardCardDto>;
  readonly closeReason: string;
  readonly bulkMutation: ReturnType<typeof useBulkQuickAction>['bulkMutation'];
  readonly bulkLabelMutation: ReturnType<
    typeof useBulkLabelAction
  >['bulkLabelMutation'];
}

export interface BulkConfirmDispatch {
  readonly handleConfirm: () => void;
}

export function useBulkConfirmDispatch({
  confirmingAction,
  selectedIds,
  cardsById,
  closeReason,
  bulkMutation,
  bulkLabelMutation,
}: UseBulkConfirmDispatchParams): BulkConfirmDispatch {
  const handleConfirm = useCallback(() => {
    if (confirmingAction === null) {
      return;
    }
    if (confirmingAction.kind === 'add-label') {
      const ids = filterIdsPresentOnBoard(selectedIds, cardsById);
      if (ids.length === 0) {
        return;
      }
      bulkLabelMutation.mutate({ label: confirmingAction.label, ids });
      return;
    }
    const targets = buildTargetsForAction(
      confirmingAction,
      selectedIds,
      cardsById,
      closeReason,
    );
    if (targets.length === 0) {
      return;
    }
    bulkMutation.mutate({ action: confirmingAction, targets });
  }, [
    confirmingAction,
    selectedIds,
    cardsById,
    closeReason,
    bulkMutation,
    bulkLabelMutation,
  ]);

  return { handleConfirm };
}
