// bdboard-sso1.74: HygienePanel.tsx の4クエリ(hygiene/harness-drift/lease-health/
// merge-slot-status)から表示用の派生値一式を計算していた部分を、挙動を変えずに
// この純関数へ移動しただけのファイル。フック(useQuery等)は一切呼ばない — 呼び出し側
// (useHygienePanel.ts)がクエリ結果を渡し、ここでは計算だけを行う。
import type { UseQueryResult } from '@tanstack/react-query';
import type {
  HygieneIssueDto,
  HygieneResponseDto,
  LeaseHealthDto,
  MergeSlotStatusDto,
  NonTicketHarnessWorktreeWarningDto,
  ReclaimProjectStatusDto,
} from '../../api';
import type {
  HarnessBulkUpdateSummary,
  HarnessBulkUpdateTarget,
} from '../../harnessBulkUpdate';
import {
  filterReclaimProjects,
  selectReclaimProblemProjects,
} from './staleLease';
import type { HarnessContractItem, HarnessHygieneItems, HarnessPackItem } from './types';

export interface HygienePanelDerivedState {
  readonly harnessDriftItems: readonly HarnessPackItem[];
  readonly bulkUpdatableItems: readonly HarnessPackItem[];
  readonly harnessContractItems: readonly HarnessContractItem[];
  readonly harnessHooksItems: readonly HarnessPackItem[];
  readonly hygieneIssues: readonly HygieneIssueDto[];
  readonly closeEvidence: HygieneResponseDto['closeEvidence'] | undefined;
  readonly closedWithoutEvidenceCount: number;
  readonly staleLeases: LeaseHealthDto['staleLeases'];
  readonly heldMergeSlots: readonly MergeSlotStatusDto[];
  readonly nonTicketHarnessWorktrees: readonly NonTicketHarnessWorktreeWarningDto[];
  readonly reclaimProjects: readonly ReclaimProjectStatusDto[];
  readonly reclaimEnabled: boolean;
  readonly reclaimProblemProjects: readonly ReclaimProjectStatusDto[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly loadError: Error | null;
  readonly hasAnyIssues: boolean;
}

export function deriveHygienePanelState(
  query: UseQueryResult<HygieneResponseDto>,
  harnessDriftQuery: UseQueryResult<HarnessHygieneItems>,
  leaseHealthQuery: UseQueryResult<LeaseHealthDto>,
  mergeSlotQuery: UseQueryResult<MergeSlotStatusDto[]>,
  projectIds: readonly string[],
  bulkUpdateTargets: readonly HarnessBulkUpdateTarget[] | null,
  bulkUpdateSummary: HarnessBulkUpdateSummary | null,
): HygienePanelDerivedState {
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

  return {
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
    isLoading,
    isError,
    loadError,
    hasAnyIssues,
  };
}
