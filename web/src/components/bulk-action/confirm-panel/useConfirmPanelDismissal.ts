// bdboard-sso1.65: useBulkActions.ts (親フック) から、確認パネルを閉じる経路
// (キャンセルボタン/Escape) と、そのために必要な useFocusTrap の配線を
// カスタムフックへ切り出した。handleCancelConfirm は分割前は
// [bulkMutation.isPending, bulkLabelMutation.isPending] を依存配列に持っていたが、
// ここでは親が計算した mutationPending (= 両者の論理和) を1つの依存として受け取る
// (値は分割前と同じタイミングで同じ真偽値になる)。confirmingAction/
// deferPeriodKind/customDeferDate/closeReason の初期値リセットは
// useConfirmPanelState.resetConfirmFields に一本化した (分割前は setConfirmingAction
// (null) / setDeferPeriodKind(DEFAULT_DEFER_PERIOD) / setCustomDeferDate('') /
// setCloseReason('') の4回の個別呼び出しだったが、結果として同じ状態になる)。
import { useCallback, type RefObject } from 'react';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import type { BulkConfirmingAction } from '../types';

export interface UseConfirmPanelDismissalParams {
  readonly confirmingAction: BulkConfirmingAction | null;
  readonly mutationPending: boolean;
  readonly confirmPanelRef: RefObject<HTMLDivElement | null>;
  readonly cancelConfirmRef: RefObject<HTMLButtonElement | null>;
  readonly resetConfirmFields: () => void;
}

export interface ConfirmPanelDismissal {
  readonly handleCancelConfirm: () => void;
}

export function useConfirmPanelDismissal({
  confirmingAction,
  mutationPending,
  confirmPanelRef,
  cancelConfirmRef,
  resetConfirmFields,
}: UseConfirmPanelDismissalParams): ConfirmPanelDismissal {
  const handleCancelConfirm = useCallback(() => {
    if (mutationPending) {
      return;
    }
    resetConfirmFields();
  }, [mutationPending, resetConfirmFields]);

  useFocusTrap({
    containerRef: confirmPanelRef,
    initialFocusRef: cancelConfirmRef,
    enabled: confirmingAction !== null,
    onEscape: handleCancelConfirm,
  });

  return { handleCancelConfirm };
}
