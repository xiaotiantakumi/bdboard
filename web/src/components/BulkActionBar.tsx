import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  postTicketAddLabel,
  postTicketQuickAction,
  postTicketQuickActionUndo,
} from '../api';
import {
  computeDeferUntilDate,
  DEFAULT_DEFER_PERIOD,
  isFutureLocalDate,
  type DeferPeriodKind,
} from '../deferPeriods';
import {
  type BulkIdOutcome,
  type BulkQuickActionOutcome,
  type BulkQuickActionTarget,
  runBulkById,
  runBulkQuickAction,
} from '../bulkQuickAction';
import { planQuickActionUndo } from '../quickActionUndo';
import { useBulkBarHeightVar } from '../hooks/useBulkBarHeightVar';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useBulkSelection } from './BulkSelectionProvider';
import { useUndoSnackbar } from './UndoSnackbar';
import { bulkSuccessMessage } from './bulk-action/messages';
import {
  buildTargetsForAction,
  countEligibleForAction,
  filterIdsPresentOnBoard,
} from './bulk-action/targets';
import type { BulkActionBarProps, BulkConfirmingAction } from './bulk-action/types';
import { BulkActionSummaryBar } from './bulk-action/BulkActionSummaryBar';
import { BulkActionDeferGroup } from './bulk-action/BulkActionDeferGroup';
import { BulkActionLabelGroup } from './bulk-action/BulkActionLabelGroup';
import { BulkActionMessages } from './bulk-action/BulkActionMessages';
import { BulkActionConfirmPanel } from './bulk-action/BulkActionConfirmPanel';

export type { BulkActionBarProps } from './bulk-action/types';

export function BulkActionBar({
  cardsById,
  availableLabels = [],
}: BulkActionBarProps) {
  const bulkSelection = useBulkSelection();
  const undoSnackbar = useUndoSnackbar();
  const queryClient = useQueryClient();
  const [confirmingAction, setConfirmingAction] =
    useState<BulkConfirmingAction | null>(null);
  const [deferPeriodKind, setDeferPeriodKind] =
    useState<DeferPeriodKind>(DEFAULT_DEFER_PERIOD);
  const [customDeferDate, setCustomDeferDate] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const [bulkLabelInput, setBulkLabelInput] = useState('');
  const [lastOutcome, setLastOutcome] = useState<
    BulkQuickActionOutcome | BulkIdOutcome | null
  >(null);
  const barRef = useRef<HTMLDivElement>(null);
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);

  const selectedIds = bulkSelection?.selectedIds ?? new Set<string>();
  const selectedCount = selectedIds.size;
  useBulkBarHeightVar(barRef, selectedCount > 0);

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

  const handleCancelConfirm = useCallback(() => {
    if (bulkMutation.isPending || bulkLabelMutation.isPending) {
      return;
    }
    setConfirmingAction(null);
    setDeferPeriodKind(DEFAULT_DEFER_PERIOD);
    setCustomDeferDate('');
    setCloseReason('');
  }, [bulkMutation.isPending, bulkLabelMutation.isPending]);

  useFocusTrap({
    containerRef: confirmPanelRef,
    initialFocusRef: cancelConfirmRef,
    enabled: confirmingAction !== null,
    onEscape: handleCancelConfirm,
  });

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

  const handleDeferBulkAction = useCallback(() => {
    const untilDate =
      deferPeriodKind === 'custom'
        ? customDeferDate
        : computeDeferUntilDate(deferPeriodKind);
    setConfirmingAction({ kind: 'defer', untilDate });
  }, [customDeferDate, deferPeriodKind]);

  const handleBulkLabelAction = useCallback(() => {
    if (!canSubmitBulkLabel) {
      return;
    }
    setConfirmingAction({ kind: 'add-label', label: trimmedBulkLabelInput });
  }, [canSubmitBulkLabel, trimmedBulkLabelInput]);

  if (bulkSelection === null || selectedCount === 0) {
    return null;
  }

  const confirmingTargetCount =
    confirmingAction !== null
      ? countEligibleForAction(confirmingAction, selectedIds, cardsById)
      : 0;

  const actionsDisabled =
    bulkMutation.isPending ||
    bulkLabelMutation.isPending ||
    confirmingAction !== null;
  const deferSubmitDisabled =
    deferPeriodKind === 'custom' && !isFutureLocalDate(customDeferDate);
  const mutationPending = bulkMutation.isPending || bulkLabelMutation.isPending;
  const mutationError = bulkMutation.error ?? bulkLabelMutation.error;

  return (
    <div ref={barRef} className="bulk-action-bar">
      <BulkActionSummaryBar
        selectedCount={selectedCount}
        mutationPending={mutationPending}
        onClear={() => bulkSelection.clear()}
      />
      <div className="bulk-action-bar-buttons">
        <button
          type="button"
          className="btn btn-small bulk-action-btn"
          disabled={actionsDisabled}
          onClick={() => setConfirmingAction({ kind: 'close' })}
        >
          完了
        </button>
        <BulkActionDeferGroup
          deferPeriodKind={deferPeriodKind}
          onDeferPeriodKindChange={setDeferPeriodKind}
          customDeferDate={customDeferDate}
          onCustomDeferDateChange={setCustomDeferDate}
          actionsDisabled={actionsDisabled}
          deferSubmitDisabled={deferSubmitDisabled}
          onDeferBulkAction={handleDeferBulkAction}
        />
        <button
          type="button"
          className="btn btn-small bulk-action-btn"
          disabled={actionsDisabled || !canRaiseAny}
          onClick={() => setConfirmingAction({ kind: 'priority-up' })}
        >
          優先度を上げる
        </button>
        <button
          type="button"
          className="btn btn-small bulk-action-btn"
          disabled={actionsDisabled || !canLowerAny}
          onClick={() => setConfirmingAction({ kind: 'priority-down' })}
        >
          優先度を下げる
        </button>
        <BulkActionLabelGroup
          bulkLabelInput={bulkLabelInput}
          onBulkLabelInputChange={setBulkLabelInput}
          actionsDisabled={actionsDisabled}
          canSubmitBulkLabel={canSubmitBulkLabel}
          bulkLabelSuggestions={bulkLabelSuggestions}
          trimmedBulkLabelInput={trimmedBulkLabelInput}
          onBulkLabelAction={handleBulkLabelAction}
          onSelectSuggestion={(label) => {
            setBulkLabelInput(label);
            setConfirmingAction({ kind: 'add-label', label });
          }}
        />
      </div>
      <BulkActionMessages lastOutcome={lastOutcome} mutationError={mutationError} />
      {confirmingAction !== null && (
        <BulkActionConfirmPanel
          confirmingAction={confirmingAction}
          confirmingTargetCount={confirmingTargetCount}
          closeReason={closeReason}
          onCloseReasonChange={setCloseReason}
          mutationPending={mutationPending}
          onCancel={handleCancelConfirm}
          onConfirm={handleConfirm}
          confirmPanelRef={confirmPanelRef}
          cancelConfirmRef={cancelConfirmRef}
        />
      )}
    </div>
  );
}
