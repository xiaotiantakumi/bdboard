import { useRef } from 'react';
import { useBulkBarHeightVar } from '../hooks/useBulkBarHeightVar';
import { useBulkSelection } from './BulkSelectionProvider';
import { useBulkActions } from './bulk-action/useBulkActions';
import type { BulkActionBarProps } from './bulk-action/types';
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
  const barRef = useRef<HTMLDivElement>(null);
  const {
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
  } = useBulkActions(cardsById, availableLabels, bulkSelection);

  useBulkBarHeightVar(barRef, selectedCount > 0);

  if (bulkSelection === null || selectedCount === 0) {
    return null;
  }

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
