import { LoadingIndicator } from './LoadingIndicator';
import { KIND_LABELS } from './hygiene/constants';
import { HarnessBulkUpdateSection } from './hygiene/HarnessBulkUpdateSection';
import { HarnessContractRows } from './hygiene/HarnessContractRows';
import { HarnessDriftRows } from './hygiene/HarnessDriftRows';
import { HarnessHooksRows } from './hygiene/HarnessHooksRows';
import { HygieneIssueRows } from './hygiene/HygieneIssueRows';
import { HygienePanelHeader } from './hygiene/HygienePanelHeader';
import { MergeSlotSection } from './hygiene/MergeSlotSection';
import { NonTicketHarnessWorktreeSection } from './hygiene/NonTicketHarnessWorktreeSection';
import { StaleLeaseSection } from './hygiene/StaleLeaseSection';
import type { HygienePanelProps } from './hygiene/types';
import { useHygienePanel } from './hygiene/useHygienePanel';

// HygienePanel.badge-colors.test.ts が './HygienePanel' から直接 import するため
// re-export する (定義は ./hygiene/constants に移動済み)。
export { KIND_LABELS };
export type { HygienePanelProps };

// bdboard-sso1.11 PR-B: 以下の kind バッジ JSX は表示専用コンポーネントへ移動済み
// (hygiene/StaleLeaseSection.tsx, MergeSlotSection.tsx, HarnessDriftRows.tsx,
// HarnessHooksRows.tsx, HarnessContractRows.tsx)。
// HygienePanel.badge-colors.test.ts はこのファイルのソースを正規表現
// (`hygiene-kind-([a-z_]+)`) でスキャンして CSS 側の kind 定義との過不足を
// 突き合わせている (テスト自体は変更しない方針のため)。移動先クラス名の
// リテラルをここに残しておかないと「CSS にはあるが HygienePanel は出さない
// (dead) kind」という誤検知になる — 実際には子コンポーネントが出している:
// hygiene-kind-stale_lease hygiene-kind-merge_slot hygiene-kind-harness_drift
// hygiene-kind-harness_hooks hygiene-kind-harness_contract

export function HygienePanel({
  projectIds,
  onSelectTicket,
  projectRootPaths,
}: HygienePanelProps) {
  const {
    isLoading,
    isError,
    loadError,
    hasAnyIssues,
    harnessDriftItems,
    bulkUpdatableItems,
    harnessContractItems,
    harnessHooksItems,
    hygieneIssues,
    closeEvidence,
    closedWithoutEvidenceCount,
    staleLeases,
    heldMergeSlots,
    nonTicketHarnessWorktrees,
    reclaimProjects,
    reclaimEnabled,
    reclaimProblemProjects,
    ariaLiveMessage,
    repairStatusMessage,
    repairDisabled,
    confirmingRepairKey,
    pendingRepairKey,
    repairError,
    bulkUpdateTargets,
    bulkUpdateSummary,
    isBulkUpdating,
    bulkConfirmButtonRef,
    beginRepairConfirm,
    cancelRepairConfirm,
    handleConfirmRepair,
    handleConfirmHarnessUpdate,
    handleConfirmContractTicket,
    beginBulkUpdateConfirm,
    confirmBulkUpdate,
    cancelBulkUpdateTargets,
    closeBulkUpdateSummary,
    handleCopyCleanup,
  } = useHygienePanel(projectIds);

  return (
    <section className="hygiene-panel" aria-label="ボード健全性">
      <HygienePanelHeader
        closeEvidence={closeEvidence}
        closedWithoutEvidenceCount={closedWithoutEvidenceCount}
        isLoading={isLoading}
        isError={isError}
        ariaLiveMessage={ariaLiveMessage}
        repairStatusMessage={repairStatusMessage}
      />

      {isLoading && <LoadingIndicator />}
      {isError && (
        <p className="error-message">
          {loadError !== null
            ? loadError.message
            : '健全性チェックの読み込みに失敗しました'}
        </p>
      )}
      {!isLoading && !isError && !hasAnyIssues && (
        <p className="empty-message">警告はありません</p>
      )}
      {!isLoading && !isError && hasAnyIssues && (
        <ul className="hygiene-issue-list">
          <StaleLeaseSection
            staleLeases={staleLeases}
            reclaimEnabled={reclaimEnabled}
            reclaimProjects={reclaimProjects}
            reclaimProblemProjects={reclaimProblemProjects}
            onSelectTicket={onSelectTicket}
          />
          <MergeSlotSection heldMergeSlots={heldMergeSlots} />
          <NonTicketHarnessWorktreeSection
            nonTicketHarnessWorktrees={nonTicketHarnessWorktrees}
          />
          <HarnessBulkUpdateSection
            bulkUpdatableItems={bulkUpdatableItems}
            bulkUpdateTargets={bulkUpdateTargets}
            bulkUpdateSummary={bulkUpdateSummary}
            repairDisabled={repairDisabled}
            isBulkUpdating={isBulkUpdating}
            bulkConfirmButtonRef={bulkConfirmButtonRef}
            onBeginBulkUpdateConfirm={() => beginBulkUpdateConfirm(bulkUpdatableItems)}
            onConfirmBulkUpdate={confirmBulkUpdate}
            onCancelBulkUpdateTargets={cancelBulkUpdateTargets}
            onCloseBulkUpdateSummary={closeBulkUpdateSummary}
          />
          <HarnessDriftRows
            items={harnessDriftItems}
            confirmingRepairKey={confirmingRepairKey}
            pendingRepairKey={pendingRepairKey}
            repairError={repairError}
            repairDisabled={repairDisabled}
            onBeginRepairConfirm={beginRepairConfirm}
            onConfirmHarnessUpdate={handleConfirmHarnessUpdate}
            onCancelConfirm={cancelRepairConfirm}
          />
          <HarnessHooksRows
            items={harnessHooksItems}
            confirmingRepairKey={confirmingRepairKey}
            pendingRepairKey={pendingRepairKey}
            repairError={repairError}
            repairDisabled={repairDisabled}
            onBeginRepairConfirm={beginRepairConfirm}
            onConfirmHarnessUpdate={handleConfirmHarnessUpdate}
            onCancelConfirm={cancelRepairConfirm}
          />
          <HarnessContractRows
            items={harnessContractItems}
            confirmingRepairKey={confirmingRepairKey}
            pendingRepairKey={pendingRepairKey}
            repairError={repairError}
            repairDisabled={repairDisabled}
            onBeginRepairConfirm={beginRepairConfirm}
            onConfirmContractTicket={handleConfirmContractTicket}
            onCancelConfirm={cancelRepairConfirm}
          />
          <HygieneIssueRows
            issues={hygieneIssues}
            projectRootPaths={projectRootPaths}
            confirmingRepairKey={confirmingRepairKey}
            pendingRepairKey={pendingRepairKey}
            repairError={repairError}
            repairDisabled={repairDisabled}
            onSelectTicket={onSelectTicket}
            onBeginRepairConfirm={beginRepairConfirm}
            onConfirmRepair={handleConfirmRepair}
            onCancelConfirm={cancelRepairConfirm}
            onCopyCleanup={(script) => {
              void handleCopyCleanup(script);
            }}
          />
        </ul>
      )}
    </section>
  );
}
