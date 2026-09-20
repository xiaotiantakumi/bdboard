import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { fetchHygiene, fetchLeaseHealth, fetchMergeSlotStatus } from '../api';
import { copyTextToClipboard } from '../bdCommands';
import { LoadingIndicator } from './LoadingIndicator';
import { useAutoClearedValue } from '../hooks/useAutoClearedValue';
import { COPY_FEEDBACK_MS, KIND_LABELS } from './hygiene/constants';
import { fetchHarnessHygieneItems } from './hygiene/harnessHygiene';
import { StaleLeaseSection } from './hygiene/StaleLeaseSection';
import { MergeSlotSection } from './hygiene/MergeSlotSection';
import { NonTicketHarnessWorktreeSection } from './hygiene/NonTicketHarnessWorktreeSection';
import { HarnessBulkUpdateSection } from './hygiene/HarnessBulkUpdateSection';
import { HarnessDriftRows } from './hygiene/HarnessDriftRows';
import { HarnessHooksRows } from './hygiene/HarnessHooksRows';
import { HarnessContractRows } from './hygiene/HarnessContractRows';
import { HygieneIssueRows } from './hygiene/HygieneIssueRows';
import {
  filterReclaimProjects,
  selectReclaimProblemProjects,
} from './hygiene/staleLease';
import { useHygieneRepairActions } from './hygiene/useHygieneRepairActions';
import type { HygienePanelProps } from './hygiene/types';

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
  const projectIdsKey = projectIds.join(',');
  const query = useQuery({
    queryKey: ['hygiene', projectIdsKey],
    queryFn: () => fetchHygiene(projectIds),
  });
  const harnessDriftQuery = useQuery({
    queryKey: ['harness-drift', projectIdsKey],
    queryFn: () => fetchHarnessHygieneItems(projectIds),
  });
  const leaseHealthQuery = useQuery({
    queryKey: ['lease-health', projectIdsKey],
    queryFn: () => fetchLeaseHealth(projectIds),
  });
  const mergeSlotQuery = useQuery({
    queryKey: ['merge-slot-status', projectIdsKey],
    queryFn: () => fetchMergeSlotStatus(projectIds),
  });

  // bdboard-ty72: どちらの表示も await の継続から出る (コピーは
  // copyTextToClipboard、修復ステータスは invalidateQueries の後)。素の setTimeout
  // だとアンマウント後にタイマーを仕掛けうるので、useAutoClearedValue に任せる。
  const { value: ariaLiveMessage, show: showCopyMessage } = useAutoClearedValue(
    '',
    COPY_FEEDBACK_MS,
  );
  const {
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
  } = useHygieneRepairActions();

  const handleCopyCleanup = useCallback(
    async (script: string) => {
      try {
        await copyTextToClipboard(script);
        showCopyMessage('掃除コマンドをコピーしました');
      } catch (copyError) {
        console.error('Failed to copy worktree cleanup commands', copyError);
        showCopyMessage('コピーできませんでした');
      }
    },
    [showCopyMessage],
  );

  const harnessDriftItems = harnessDriftQuery.data?.driftItems ?? [];
  // drift はサーバー側で installedVersion !== null のときだけ立つが、一括更新の範囲は
  // 「注入済みパックの更新」だけなので、未導入が紛れ込まないよう念のため絞る。
  const bulkUpdatableItems = harnessDriftItems.filter(
    (item) => item.pack.installedVersion !== null,
  );
  const harnessContractItems = harnessDriftQuery.data?.contractItems ?? [];
  const harnessHooksItems = harnessDriftQuery.data?.hooksItems ?? [];
  const hygieneIssues = query.data?.issues ?? [];
  const closeEvidence = query.data?.closeEvidence;
  const closedWithoutEvidenceCount = hygieneIssues.filter(
    (issue) => issue.kind === 'closed_without_evidence',
  ).length;
  const showCloseEvidenceNote =
    closeEvidence != null && closeEvidence.unknownCount > 0;
  const staleLeases = leaseHealthQuery.data?.staleLeases ?? [];
  const heldMergeSlots = (mergeSlotQuery.data ?? []).filter(
    (status) => status.held,
  );
  const nonTicketHarnessWorktrees = query.data?.nonTicketHarnessWorktrees ?? [];
  const reclaimProjects = filterReclaimProjects(
    leaseHealthQuery.data,
    projectIds,
  );
  const reclaimEnabled = leaseHealthQuery.data?.reclaim.enabled !== false;
  const reclaimProblemProjects = selectReclaimProblemProjects(
    reclaimProjects,
    reclaimEnabled,
  );
  const isLoading =
    query.isLoading ||
    harnessDriftQuery.isLoading ||
    leaseHealthQuery.isLoading ||
    mergeSlotQuery.isLoading;
  const isError =
    query.isError ||
    harnessDriftQuery.isError ||
    leaseHealthQuery.isError ||
    mergeSlotQuery.isError;
  const loadError =
    query.error instanceof Error
      ? query.error
      : harnessDriftQuery.error instanceof Error
        ? harnessDriftQuery.error
        : leaseHealthQuery.error instanceof Error
          ? leaseHealthQuery.error
          : mergeSlotQuery.error instanceof Error
            ? mergeSlotQuery.error
            : null;
  const hasAnyIssues =
    hygieneIssues.length > 0 ||
    harnessDriftItems.length > 0 ||
    harnessContractItems.length > 0 ||
    harnessHooksItems.length > 0 ||
    staleLeases.length > 0 ||
    reclaimProblemProjects.length > 0 ||
    heldMergeSlots.length > 0 ||
    nonTicketHarnessWorktrees.length > 0 ||
    // 全件成功で要更新が 0 件になっても、一括更新の確認・結果は消さずに見せる。
    bulkUpdateTargets !== null ||
    bulkUpdateSummary !== null;

  return (
    <section className="hygiene-panel" aria-label="ボード健全性">
      <div className="hygiene-panel-header">
        <h2 className="hygiene-panel-title">ボード健全性</h2>
        <p className="hygiene-panel-subtitle">
          台帳の腐りを検知した警告一覧です
        </p>
        {!isLoading && !isError && showCloseEvidenceNote && (
          <p className="hygiene-panel-close-evidence-note" role="status">
            close 証拠なし: {closedWithoutEvidenceCount}件（
            {closeEvidence.unknownCount}件は未確認）
            {' '}
            未確認のぶんは判定を見送っています（時間をおくと確定します）
          </p>
        )}
        <span className="hygiene-panel-feedback" role="status" aria-live="polite">
          {ariaLiveMessage}
        </span>
        <span
          className="hygiene-panel-repair-status"
          role="status"
          aria-live="polite"
        >
          {repairStatusMessage}
        </span>
      </div>

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
