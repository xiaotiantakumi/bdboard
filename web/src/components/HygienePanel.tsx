import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HygieneIssueDto, ProjectHarnessPackStatusDto, QuickActionRequest } from '../api';
import {
  fetchHygiene,
  fetchLeaseHealth,
  fetchMergeSlotStatus,
  postProjectHarnessContractTicket,
  postProjectHarnessInject,
  postTicketQuickAction,
  postTicketQuickActionUndo,
} from '../api';
import { copyTextToClipboard } from '../bdCommands';
import { LoadingIndicator } from './LoadingIndicator';
import { buildHarnessContractTicketSuccessMessage, buildHarnessInjectSuccessMessage } from '../harnessDisplay';
import { useAutoClearedValue } from '../hooks/useAutoClearedValue';
import { planQuickActionUndo } from '../quickActionUndo';
import { describeWriteError } from '../writeAccessMessage';
import {
  buildHarnessBulkSummaryMessage,
  runHarnessBulkUpdate,
  type HarnessBulkUpdateSummary,
  type HarnessBulkUpdateTarget,
} from '../harnessBulkUpdate';
import { useUndoSnackbar } from './UndoSnackbar';
import {
  COPY_FEEDBACK_MS,
  KIND_LABELS,
  REPAIR_FEEDBACK_MS,
} from './hygiene/constants';
import { fetchHarnessHygieneItems } from './hygiene/harnessHygiene';
import { buildRepairRequest, buildRepairSuccessMessage } from './hygiene/issueDisplay';
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
import type {
  HarnessContractItem,
  HarnessPackItem,
  HygienePanelProps,
  RepairFeedback,
} from './hygiene/types';

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
  const queryClient = useQueryClient();
  const undoSnackbar = useUndoSnackbar();
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
    value: repairStatusMessage,
    show: showRepairStatusMessage,
    clear: clearRepairStatusMessage,
  } = useAutoClearedValue('', REPAIR_FEEDBACK_MS);
  const [confirmingRepairKey, setConfirmingRepairKey] = useState<string | null>(
    null,
  );
  const [pendingRepairKey, setPendingRepairKey] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<RepairFeedback | null>(null);
  const [bulkUpdateTargets, setBulkUpdateTargets] = useState<
    readonly HarnessBulkUpdateTarget[] | null
  >(null);
  const [bulkUpdateSummary, setBulkUpdateSummary] =
    useState<HarnessBulkUpdateSummary | null>(null);

  const clearRepairFeedback = useCallback(() => {
    setRepairError(null);
    clearRepairStatusMessage();
  }, [clearRepairStatusMessage]);

  const beginRepairConfirm = useCallback(
    (rowKey: string) => {
      setConfirmingRepairKey(rowKey);
      // 確認欄は同時に1つだけ開く (一括更新の確認も閉じる)。
      setBulkUpdateTargets(null);
      clearRepairFeedback();
    },
    [clearRepairFeedback],
  );

  const repairMutation = useMutation({
    mutationFn: async (vars: {
      rowKey: string;
      ticketId: string;
      request: QuickActionRequest;
      previousDeferUntil?: string;
    }) => {
      await postTicketQuickAction(vars.ticketId, vars.request);
      return vars;
    },
    onMutate: (vars) => {
      setPendingRepairKey(vars.rowKey);
      clearRepairFeedback();
    },
    onSuccess: async (vars) => {
      await queryClient.invalidateQueries({ queryKey: ['hygiene'] });
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      setConfirmingRepairKey(null);
      setPendingRepairKey(null);

      showRepairStatusMessage(
        buildRepairSuccessMessage(vars.request, vars.ticketId),
      );

      const plan = planQuickActionUndo(
        vars.request,
        undefined,
        vars.previousDeferUntil,
      );
      if (plan !== null) {
        undoSnackbar?.showUndo({
          message: plan.message,
          onUndo: async () => {
            await postTicketQuickActionUndo(vars.ticketId, plan.undoRequest);
            await queryClient.invalidateQueries({ queryKey: ['hygiene'] });
            await queryClient.invalidateQueries({ queryKey: ['board'] });
          },
        });
      }
    },
    onError: (error, vars) => {
      setPendingRepairKey(null);
      setRepairError({
        rowKey: vars.rowKey,
        message: describeWriteError(error, '修復を実行できませんでした'),
      });
    },
  });

  const harnessInjectMutation = useMutation({
    mutationFn: async (vars: {
      rowKey: string;
      projectId: string;
      pack: ProjectHarnessPackStatusDto;
    }) => {
      await postProjectHarnessInject(vars.projectId, vars.pack.name);
      return vars;
    },
    onMutate: (vars) => {
      setPendingRepairKey(vars.rowKey);
      clearRepairFeedback();
    },
    onSuccess: async (vars) => {
      await queryClient.invalidateQueries({ queryKey: ['harness-drift'] });
      await queryClient.invalidateQueries({
        queryKey: ['project-harness', vars.projectId],
      });
      setConfirmingRepairKey(null);
      setPendingRepairKey(null);
      // 単体で直した後に古い一括結果 (「失敗」行など) を残さない。
      setBulkUpdateSummary(null);
      showRepairStatusMessage(
        buildHarnessInjectSuccessMessage(vars.pack.name, vars.pack),
      );
    },
    onError: (error, vars) => {
      setPendingRepairKey(null);
      setRepairError({
        rowKey: vars.rowKey,
        message: describeWriteError(error, 'ハーネスの更新に失敗しました'),
      });
    },
  });

  const harnessBulkUpdateMutation = useMutation({
    mutationFn: (targets: readonly HarnessBulkUpdateTarget[]) =>
      runHarnessBulkUpdate(targets, (target) =>
        postProjectHarnessInject(target.projectId, target.packName),
      ),
    onMutate: () => {
      setBulkUpdateSummary(null);
      clearRepairFeedback();
    },
    onSuccess: async (summary) => {
      await queryClient.invalidateQueries({ queryKey: ['project-harness'] });
      await queryClient.invalidateQueries({ queryKey: ['harness-drift'] });
      await queryClient.invalidateQueries({ queryKey: ['harness-status-all'] });
      setBulkUpdateTargets(null);
      setBulkUpdateSummary(summary);
      // 件数は常駐の aria-live に流す (後から挿入された role=status は読まれにくい)。
      showRepairStatusMessage(buildHarnessBulkSummaryMessage(summary));
    },
  });

  /**
   * 検証コントラクト不足を直すチケット起票 (bdboard-p5l.25)。drift/hooks の
   * 「再注入で直す」とは違い、bd 側にチケットを立てるだけ (ファイルは書き換えない)。
   * 冪等性 (既存の harness-contract ラベル付き未クローズチケットがあれば新規作成しない)
   * はサーバー側 (fileHarnessContractTicket) の責務 — ここは結果の created で
   * 文言を出し分けるだけ。
   */
  const contractTicketMutation = useMutation({
    mutationFn: async (vars: { rowKey: string; projectId: string }) => {
      const result = await postProjectHarnessContractTicket(vars.projectId);
      return { ...vars, result };
    },
    onMutate: (vars) => {
      setPendingRepairKey(vars.rowKey);
      clearRepairFeedback();
    },
    onSuccess: async (vars) => {
      await queryClient.invalidateQueries({ queryKey: ['harness-drift'] });
      await queryClient.invalidateQueries({
        queryKey: ['project-harness', vars.projectId],
      });
      setConfirmingRepairKey(null);
      setPendingRepairKey(null);
      // 単体で直した後に古い一括結果 (「失敗」行など) を残さない。
      setBulkUpdateSummary(null);
      // bdboard-13mp: state 遷移をまたいだ陳腐化チケットの扱い — 文言に使う contract は
      // クリック時点でこのコンポーネントがポーリングでキャッシュしていた item.contract
      // ではなく、サーバーがこのリクエストで実際に読んだ vars.result.contract を使う
      // (レビュー指摘)。ポーリングキャッシュとの間には、最後のポーリングからクリック
      // までの間に契約ファイルが変わっている可能性がある窓があり、それをそのまま
      // 使うと「追記した」と言いながら別の (古い) 状態名を出しかねない — まさに
      // この機能が直そうとしている陳腐化表示をクライアント側で再発させてしまう。
      showRepairStatusMessage(
        buildHarnessContractTicketSuccessMessage(
          vars.result.ticketId,
          vars.result.created,
          vars.result.stateAppend,
          vars.result.contract,
        ),
      );
    },
    onError: (error, vars) => {
      setPendingRepairKey(null);
      setRepairError({
        rowKey: vars.rowKey,
        message: describeWriteError(error, 'チケットの起票に失敗しました'),
      });
    },
  });

  const handleConfirmRepair = useCallback(
    (issue: HygieneIssueDto, rowKey: string) => {
      if (repairMutation.isPending) {
        return;
      }
      const built = buildRepairRequest(issue);
      if (built === null) {
        return;
      }
      repairMutation.mutate({
        rowKey,
        ticketId: issue.ticketId,
        request: built.request,
        previousDeferUntil: built.previousDeferUntil,
      });
    },
    [repairMutation],
  );

  // drift 行と hook 未登録行はどちらも「再注入で直す」なので同じハンドラを使う。
  const handleConfirmHarnessUpdate = useCallback(
    (item: HarnessPackItem, rowKey: string) => {
      if (repairMutation.isPending || harnessInjectMutation.isPending) {
        return;
      }
      harnessInjectMutation.mutate({
        rowKey,
        projectId: item.projectId,
        pack: item.pack,
      });
    },
    [harnessInjectMutation, repairMutation.isPending],
  );

  const handleConfirmContractTicket = useCallback(
    (item: HarnessContractItem, rowKey: string) => {
      if (contractTicketMutation.isPending) {
        return;
      }
      contractTicketMutation.mutate({ rowKey, projectId: item.projectId });
    },
    [contractTicketMutation],
  );

  const beginBulkUpdateConfirm = useCallback(
    (items: readonly HarnessPackItem[]) => {
      setBulkUpdateSummary(null);
      setConfirmingRepairKey(null);
      clearRepairFeedback();
      setBulkUpdateTargets(
        items.map(({ projectId, pack }) => ({
          projectId,
          packName: pack.name,
          installedVersion: pack.installedVersion,
          availableVersion: pack.availableVersion,
        })),
      );
    },
    [clearRepairFeedback],
  );

  const confirmBulkUpdate = useCallback(() => {
    if (bulkUpdateTargets !== null && !harnessBulkUpdateMutation.isPending) {
      harnessBulkUpdateMutation.mutate(bulkUpdateTargets);
    }
  }, [bulkUpdateTargets, harnessBulkUpdateMutation]);

  // 確認欄を開いたら確定ボタンへフォーカスを移す (トリガーのボタンはアンマウントされる)。
  const bulkConfirmButtonRef = useRef<HTMLButtonElement>(null);
  const isBulkConfirming = bulkUpdateTargets !== null;
  useEffect(() => {
    if (isBulkConfirming) {
      bulkConfirmButtonRef.current?.focus();
    }
  }, [isBulkConfirming]);

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

  const repairDisabled =
    repairMutation.isPending ||
    harnessInjectMutation.isPending ||
    harnessBulkUpdateMutation.isPending ||
    contractTicketMutation.isPending;
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
            isBulkUpdating={harnessBulkUpdateMutation.isPending}
            bulkConfirmButtonRef={bulkConfirmButtonRef}
            onBeginBulkUpdateConfirm={() => beginBulkUpdateConfirm(bulkUpdatableItems)}
            onConfirmBulkUpdate={confirmBulkUpdate}
            onCancelBulkUpdateTargets={() => setBulkUpdateTargets(null)}
            onCloseBulkUpdateSummary={() => setBulkUpdateSummary(null)}
          />
          <HarnessDriftRows
            items={harnessDriftItems}
            confirmingRepairKey={confirmingRepairKey}
            pendingRepairKey={pendingRepairKey}
            repairError={repairError}
            repairDisabled={repairDisabled}
            onBeginRepairConfirm={beginRepairConfirm}
            onConfirmHarnessUpdate={handleConfirmHarnessUpdate}
            onCancelConfirm={() => setConfirmingRepairKey(null)}
          />
          <HarnessHooksRows
            items={harnessHooksItems}
            confirmingRepairKey={confirmingRepairKey}
            pendingRepairKey={pendingRepairKey}
            repairError={repairError}
            repairDisabled={repairDisabled}
            onBeginRepairConfirm={beginRepairConfirm}
            onConfirmHarnessUpdate={handleConfirmHarnessUpdate}
            onCancelConfirm={() => setConfirmingRepairKey(null)}
          />
          <HarnessContractRows
            items={harnessContractItems}
            confirmingRepairKey={confirmingRepairKey}
            pendingRepairKey={pendingRepairKey}
            repairError={repairError}
            repairDisabled={repairDisabled}
            onBeginRepairConfirm={beginRepairConfirm}
            onConfirmContractTicket={handleConfirmContractTicket}
            onCancelConfirm={() => setConfirmingRepairKey(null)}
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
            onCancelConfirm={() => setConfirmingRepairKey(null)}
            onCopyCleanup={(script) => {
              void handleCopyCleanup(script);
            }}
          />
        </ul>
      )}
    </section>
  );
}
