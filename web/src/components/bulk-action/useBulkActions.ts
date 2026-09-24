// bdboard-sso1.23 PR-C: BulkActionBar.tsx の「一括操作の確認〜実行〜Undo」に関する
// state + mutation + handler 一式を、挙動を変えずにこのカスタムフックへ抽出しただけの
// ファイル。呼び出し順序・依存配列・queryKey・invalidate 対象は移動前から変えていない。
//
// bdboard-sso1.60: 2つの mutation (一括クイックアクション/一括ラベル付与) をそれぞれ
// 関心別フック (./actions/*.ts) へ move-only で抽出した。
//
// bdboard-sso1.65: 確認パネルの state・useFocusTrap・kind で分岐する handleConfirm を
// ./confirm-panel/*.ts の3フック (useConfirmPanelState/useConfirmPanelDismissal/
// useBulkConfirmDispatch) へ組み替えて抽出した。このフックが公開する `BulkActions`
// (戻り値のキー名・型) は分割前から変えていない。呼び出し順序は
// 「状態 → 2つの mutation フック → 閉じる経路(dismissal) → 実行の分岐(dispatch)」
// で、分割前の相対順序 (state → bulkMutation → bulkLabelMutation →
// handleCancelConfirm/useFocusTrap → handleConfirm) を保っている。
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, type RefObject } from 'react';
import { type BoardCardDto } from '../../api';
import { computeDeferUntilDate, isFutureLocalDate, type DeferPeriodKind } from '../../deferPeriods';
import { type BulkIdOutcome, type BulkQuickActionOutcome } from '../../bulkQuickAction';
import type { BulkSelectionContextValue } from '../BulkSelectionProvider';
import { useUndoSnackbar } from '../UndoSnackbar';
import { useBulkLabelAction } from './actions/useBulkLabelAction';
import { useBulkQuickAction } from './actions/useBulkQuickAction';
import { useBulkConfirmDispatch } from './confirm-panel/useBulkConfirmDispatch';
import { useConfirmPanelDismissal } from './confirm-panel/useConfirmPanelDismissal';
import { useConfirmPanelState } from './confirm-panel/useConfirmPanelState';
import { countEligibleForAction } from './targets';
import type { BulkConfirmingAction } from './types';

export interface BulkActions {
  readonly selectedIds: ReadonlySet<string>;
  readonly selectedCount: number;
  readonly confirmingAction: BulkConfirmingAction | null;
  readonly deferPeriodKind: DeferPeriodKind;
  readonly customDeferDate: string;
  readonly closeReason: string;
  readonly bulkLabelInput: string;
  readonly lastOutcome: BulkQuickActionOutcome | BulkIdOutcome | null;
  readonly trimmedBulkLabelInput: string;
  readonly bulkLabelSuggestions: readonly string[];
  readonly canSubmitBulkLabel: boolean;
  readonly canRaiseAny: boolean;
  readonly canLowerAny: boolean;
  readonly confirmingTargetCount: number;
  readonly actionsDisabled: boolean;
  readonly deferSubmitDisabled: boolean;
  readonly mutationPending: boolean;
  readonly mutationError: Error | null;
  readonly confirmPanelRef: RefObject<HTMLDivElement | null>;
  readonly cancelConfirmRef: RefObject<HTMLButtonElement | null>;
  readonly setDeferPeriodKind: (kind: DeferPeriodKind) => void;
  readonly setCustomDeferDate: (value: string) => void;
  readonly setCloseReason: (value: string) => void;
  readonly setBulkLabelInput: (value: string) => void;
  readonly setConfirmingAction: (action: BulkConfirmingAction | null) => void;
  readonly handleCancelConfirm: () => void;
  readonly handleConfirm: () => void;
  readonly handleDeferBulkAction: () => void;
  readonly handleBulkLabelAction: () => void;
}

export function useBulkActions(
  cardsById: ReadonlyMap<string, BoardCardDto>,
  availableLabels: readonly string[],
  bulkSelection: BulkSelectionContextValue | null,
): BulkActions {
  const undoSnackbar = useUndoSnackbar();
  const queryClient = useQueryClient();

  const {
    confirmingAction,
    deferPeriodKind,
    customDeferDate,
    closeReason,
    bulkLabelInput,
    lastOutcome,
    confirmPanelRef,
    cancelConfirmRef,
    setConfirmingAction,
    setDeferPeriodKind,
    setCustomDeferDate,
    setCloseReason,
    setBulkLabelInput,
    setLastOutcome,
    resetConfirmFields,
  } = useConfirmPanelState();

  const selectedIds = bulkSelection?.selectedIds ?? new Set<string>();
  const selectedCount = selectedIds.size;

  const trimmedBulkLabelInput = bulkLabelInput.trim();
  const bulkLabelSuggestions = availableLabels
    .filter(
      (label) =>
        trimmedBulkLabelInput.length === 0 ||
        label.toLowerCase().includes(trimmedBulkLabelInput.toLowerCase()),
    )
    .slice(0, 20);

  const canSubmitBulkLabel = trimmedBulkLabelInput.length > 0;

  const canRaiseAny = useMemo(() => {
    for (const id of selectedIds) {
      const card = cardsById.get(id);
      if (card !== undefined && card.ticket.priority > 0) {
        return true;
      }
    }
    return false;
  }, [selectedIds, cardsById]);

  const canLowerAny = useMemo(() => {
    for (const id of selectedIds) {
      const card = cardsById.get(id);
      if (card !== undefined && card.ticket.priority < 4) {
        return true;
      }
    }
    return false;
  }, [selectedIds, cardsById]);

  const { bulkMutation } = useBulkQuickAction({
    queryClient,
    bulkSelection,
    undoSnackbar,
    setLastOutcome,
    setConfirmingAction,
    setDeferPeriodKind,
    setCustomDeferDate,
    setCloseReason,
  });

  const { bulkLabelMutation } = useBulkLabelAction({
    queryClient,
    bulkSelection,
    setLastOutcome,
    setConfirmingAction,
    setBulkLabelInput,
  });

  const mutationPending = bulkMutation.isPending || bulkLabelMutation.isPending;

  const { handleCancelConfirm } = useConfirmPanelDismissal({
    confirmingAction,
    mutationPending,
    confirmPanelRef,
    cancelConfirmRef,
    resetConfirmFields,
  });

  const { handleConfirm } = useBulkConfirmDispatch({
    confirmingAction,
    selectedIds,
    cardsById,
    closeReason,
    bulkMutation,
    bulkLabelMutation,
  });

  const handleDeferBulkAction = useCallback(() => {
    const untilDate =
      deferPeriodKind === 'custom'
        ? customDeferDate
        : computeDeferUntilDate(deferPeriodKind);
    setConfirmingAction({ kind: 'defer', untilDate });
  }, [customDeferDate, deferPeriodKind, setConfirmingAction]);

  const handleBulkLabelAction = useCallback(() => {
    if (!canSubmitBulkLabel) {
      return;
    }
    setConfirmingAction({ kind: 'add-label', label: trimmedBulkLabelInput });
  }, [canSubmitBulkLabel, trimmedBulkLabelInput, setConfirmingAction]);

  const confirmingTargetCount =
    confirmingAction !== null
      ? countEligibleForAction(confirmingAction, selectedIds, cardsById)
      : 0;

  const actionsDisabled = mutationPending || confirmingAction !== null;
  const deferSubmitDisabled =
    deferPeriodKind === 'custom' && !isFutureLocalDate(customDeferDate);
  const mutationError = bulkMutation.error ?? bulkLabelMutation.error;

  return {
    selectedIds,
    selectedCount,
    confirmingAction,
    deferPeriodKind,
    customDeferDate,
    closeReason,
    bulkLabelInput,
    lastOutcome,
    trimmedBulkLabelInput,
    bulkLabelSuggestions,
    canSubmitBulkLabel,
    canRaiseAny,
    canLowerAny,
    confirmingTargetCount,
    actionsDisabled,
    deferSubmitDisabled,
    mutationPending,
    mutationError,
    confirmPanelRef,
    cancelConfirmRef,
    setDeferPeriodKind,
    setCustomDeferDate,
    setCloseReason,
    setBulkLabelInput,
    setConfirmingAction,
    handleCancelConfirm,
    handleConfirm,
    handleDeferBulkAction,
    handleBulkLabelAction,
  };
}
