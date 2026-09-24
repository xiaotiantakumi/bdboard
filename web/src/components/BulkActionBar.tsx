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
import { useBulkAgentRun } from './bulk-action/agent-run/useBulkAgentRun';
import { BulkRunConfirmPanel } from './bulk-action/agent-run/BulkRunConfirmPanel';

export type { BulkActionBarProps } from './bulk-action/types';

export function BulkActionBar({
  cardsById,
  availableLabels = [],
  agentRun: agentRunConfig,
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
    actionsDisabled: mutationActionsDisabled,
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
  // bdboard-mkm1.2: 「▶ 実行」の確認中は他の一括操作を押させない (逆も同じ —
  // mutationActionsDisabled の間は「▶ 実行」を押させない)。
  const agentRun = useBulkAgentRun({
    config: agentRunConfig,
    bulkSelection,
    cardsById,
    barBusy: mutationActionsDisabled,
  });
  const actionsDisabled = mutationActionsDisabled || agentRun.confirmOpen;

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
        {agentRun.enabled && (
          <button
            type="button"
            className="btn btn-small bulk-action-btn bulk-run-btn"
            disabled={actionsDisabled || agentRun.runDisabledReason !== null}
            title={agentRun.runDisabledReason ?? undefined}
            onClick={agentRun.openConfirm}
          >
            ▶ 実行
          </button>
        )}
      </div>
      {agentRun.enabled && agentRun.runDisabledReason !== null && (
        <p className="bulk-run-blocked-reason">{agentRun.runDisabledReason}</p>
      )}
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
      {agentRun.confirmOpen && (
        <BulkRunConfirmPanel
          plan={agentRun.plan}
          harnessBlockReason={agentRun.harnessBlockReason}
          canConfirm={agentRun.canConfirm}
          onCancel={agentRun.cancelConfirm}
          onConfirm={agentRun.confirmRun}
          confirmPanelRef={agentRun.confirmPanelRef}
          cancelConfirmRef={agentRun.cancelConfirmRef}
        />
      )}
    </div>
  );
}
