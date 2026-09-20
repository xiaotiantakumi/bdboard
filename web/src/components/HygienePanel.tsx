import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HygieneIssueDto,
  ProjectHarnessPackStatusDto,
  QuickActionRequest,
} from '../api';
import {
  fetchHygiene,
  fetchLeaseHealth,
  fetchMergeSlotStatus,
  postProjectHarnessContractTicket,
  postProjectHarnessInject,
  postTicketQuickAction,
  postTicketQuickActionUndo,
  projectNameFallback,
} from '../api';
import { copyTextToClipboard, formatDependencyCycleRemovalScript } from '../bdCommands';
import { LoadingIndicator } from './LoadingIndicator';
import {
  buildHarnessContractTicketSuccessMessage,
  buildHarnessDriftMessage,
  buildHarnessHooksMessage,
  buildHarnessInjectSuccessMessage,
  formatHarnessContractDetail,
  formatHarnessContractLabel,
  formatHarnessHooksDetail,
  harnessContractNeedsTicket,
} from '../harnessDisplay';
import { useAutoClearedValue } from '../hooks/useAutoClearedValue';
import { planQuickActionUndo } from '../quickActionUndo';
import { describeWriteError } from '../writeAccessMessage';
import {
  buildHarnessBulkSummaryMessage,
  describeHarnessBulkFailure,
  runHarnessBulkUpdate,
  type HarnessBulkUpdateSummary,
  type HarnessBulkUpdateTarget,
} from '../harnessBulkUpdate';
import { useUndoSnackbar } from './UndoSnackbar';
import {
  COPY_FEEDBACK_MS,
  HARNESS_CONTRACT_KIND_LABEL,
  HARNESS_DRIFT_KIND_LABEL,
  HARNESS_HOOKS_KIND_LABEL,
  KIND_LABELS,
  MERGE_SLOT_KIND_LABEL,
  NON_TICKET_HARNESS_WORKTREE_KIND_LABEL,
  RECLAIM_STATUS_KIND_LABEL,
  REPAIR_FEEDBACK_MS,
  STALE_LEASE_KIND_LABEL,
} from './hygiene/constants';
import { fetchHarnessHygieneItems } from './hygiene/harnessHygiene';
import {
  buildRepairRequest,
  buildRepairSuccessMessage,
  confirmRepairLabel,
  getRepairableKind,
  kindBadgeClass,
  repairActionLabel,
  resolveCleanupScript,
  severityBadgeClass,
} from './hygiene/issueDisplay';
import { ReclaimProjectLines } from './hygiene/ReclaimProjectLines';
import {
  harnessContractRowKey,
  harnessDriftRowKey,
  harnessHooksRowKey,
  issueRowKey,
} from './hygiene/rowKeys';
import {
  buildStaleLeaseMessage,
  filterReclaimProjects,
  formatStaleDuration,
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
          {staleLeases.length > 0 && (
            <li key="stale-leases">
              <div className="hygiene-stale-lease-group">
                {staleLeases.map((staleLease) => (
                  <button
                    key={staleLease.ticketId}
                    type="button"
                    className="hygiene-issue-row"
                    onClick={() => onSelectTicket(staleLease.ticketId)}
                  >
                    <span className="hygiene-kind-badge hygiene-kind-stale_lease">
                      {STALE_LEASE_KIND_LABEL}
                    </span>
                    <span className="badge badge-stalled">警告</span>
                    <span className="hygiene-issue-project" title={staleLease.projectId}>
                      {projectNameFallback(staleLease.projectId)}
                    </span>
                    <span className="hygiene-issue-id">{staleLease.ticketId}</span>
                    <span className="hygiene-issue-message">
                      {buildStaleLeaseMessage(staleLease)}
                    </span>
                  </button>
                ))}
                <div
                  className="hygiene-reclaim-status"
                  role="group"
                  aria-label="自動 reclaim 状況"
                >
                  {!reclaimEnabled ? (
                    <p>自動 reclaim は無効です</p>
                  ) : (
                    <ReclaimProjectLines projects={reclaimProjects} />
                  )}
                </div>
              </div>
            </li>
          )}
          {staleLeases.length === 0 && reclaimProblemProjects.length > 0 && (
            <li key="reclaim-status">
              {/* レイアウト (縦並び + 6px 間隔) は stale lease グループと共用する。 */}
              <div className="hygiene-stale-lease-group">
                <div className="hygiene-issue-row hygiene-issue-row-static">
                  <span className="hygiene-kind-badge hygiene-kind-stale_lease">
                    {RECLAIM_STATUS_KIND_LABEL}
                  </span>
                  <span className="badge badge-stalled">警告</span>
                  <span className="hygiene-issue-message">
                    巡回の見送り・エラーがあります
                  </span>
                </div>
                <div
                  className="hygiene-reclaim-status"
                  role="group"
                  aria-label="自動 reclaim 状況"
                >
                  <ReclaimProjectLines projects={reclaimProblemProjects} />
                </div>
              </div>
            </li>
          )}
          {heldMergeSlots.length > 0 && (
            <li key="merge-slot">
              <div className="hygiene-merge-slot-group">
                {heldMergeSlots.map((status) => (
                  <div
                    key={status.projectId}
                    className="hygiene-issue-row hygiene-issue-row-static"
                  >
                    <span className="hygiene-kind-badge hygiene-kind-merge_slot">
                      {MERGE_SLOT_KIND_LABEL}
                    </span>
                    {status.isLongHeld && (
                      <span className="badge badge-stalled">警告</span>
                    )}
                    <span className="hygiene-issue-project" title={status.projectId}>
                      {projectNameFallback(status.projectId)}
                    </span>
                    <span className="hygiene-issue-id">
                      {status.holder ?? '(不明)'}
                    </span>
                    <span className="hygiene-issue-message">
                      保持中 {formatStaleDuration(status.heldForMs)}
                    </span>
                  </div>
                ))}
              </div>
            </li>
          )}
          {nonTicketHarnessWorktrees.length > 0 && (
            <li key="non-ticket-harness-worktrees">
              <div className="hygiene-merge-slot-group">
                {nonTicketHarnessWorktrees.map((worktree) => (
                  <div
                    key={`${worktree.projectId}:${worktree.worktreePath}`}
                    className="hygiene-issue-row hygiene-issue-row-static"
                  >
                    <span className="hygiene-kind-badge hygiene-kind-stale_harness_worktree">
                      {NON_TICKET_HARNESS_WORKTREE_KIND_LABEL}
                    </span>
                    <span className="badge badge-stalled">警告</span>
                    <span className="hygiene-issue-project" title={worktree.projectId}>
                      {projectNameFallback(worktree.projectId)}
                    </span>
                    <span className="hygiene-issue-id">{worktree.branchName}</span>
                    <span className="hygiene-issue-message">{worktree.message}</span>
                  </div>
                ))}
              </div>
            </li>
          )}
          {(bulkUpdatableItems.length > 0 ||
            bulkUpdateTargets !== null ||
            bulkUpdateSummary !== null) && (
            <li key="harness-bulk-update">
              <div className="hygiene-repair">
                {bulkUpdateTargets !== null ? (
                  <div
                    className="hygiene-repair-confirm"
                    role="group"
                    aria-label="ハーネス一括更新の確認"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && !repairDisabled) {
                        event.stopPropagation();
                        setBulkUpdateTargets(null);
                      }
                    }}
                  >
                    <p>次の要更新パックを1件ずつ更新します。</p>
                    <ul>
                      {bulkUpdateTargets.map((target) => (
                        <li
                          key={`${target.projectId}-${target.packName}`}
                          title={target.projectId}
                        >
                          {projectNameFallback(target.projectId)} / {target.packName}: v
                          {target.installedVersion} → v{target.availableVersion}
                        </li>
                      ))}
                    </ul>
                    <button
                      ref={bulkConfirmButtonRef}
                      type="button"
                      className="hygiene-repair-confirm-btn"
                      disabled={repairDisabled}
                      onClick={confirmBulkUpdate}
                    >
                      {harnessBulkUpdateMutation.isPending ? '更新中…' : '確定: まとめて更新'}
                    </button>
                    <button
                      type="button"
                      className="hygiene-repair-cancel"
                      disabled={repairDisabled}
                      onClick={() => setBulkUpdateTargets(null)}
                    >
                      キャンセル
                    </button>
                  </div>
                ) : bulkUpdatableItems.length > 0 ? (
                  // 結果の表示中でも要更新が残っていれば (一部失敗など) そのまま再試行できる。
                  <button
                    type="button"
                    className="hygiene-repair-action"
                    disabled={repairDisabled}
                    onClick={() => beginBulkUpdateConfirm(bulkUpdatableItems)}
                  >
                    要更新 {bulkUpdatableItems.length} 件をまとめて更新
                  </button>
                ) : null}
                {bulkUpdateSummary !== null && bulkUpdateTargets === null && (
                  <div role="group" aria-label="ハーネス一括更新の結果">
                    <p>{buildHarnessBulkSummaryMessage(bulkUpdateSummary)}</p>
                    <ul>
                      {bulkUpdateSummary.results.map((result) => (
                        <li
                          key={`${result.target.projectId}-${result.target.packName}`}
                          title={result.target.projectId}
                        >
                          {projectNameFallback(result.target.projectId)} / {result.target.packName}:{' '}
                          {result.status === 'success'
                            ? '成功'
                            : `失敗 (${describeHarnessBulkFailure(result.error)})`}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="hygiene-repair-cancel"
                      onClick={() => setBulkUpdateSummary(null)}
                    >
                      結果を閉じる
                    </button>
                  </div>
                )}
              </div>
            </li>
          )}
          {harnessDriftItems.map((item) => {
            const rowKey = harnessDriftRowKey(item);
            const isConfirming = confirmingRepairKey === rowKey;
            const isExecuting = repairDisabled && pendingRepairKey === rowKey;
            const rowError =
              repairError?.rowKey === rowKey ? repairError.message : null;

            return (
              <li key={rowKey}>
                <div className="hygiene-issue-row hygiene-issue-row-static">
                  <span className="hygiene-kind-badge hygiene-kind-harness_drift">
                    {HARNESS_DRIFT_KIND_LABEL}
                  </span>
                  <span className="badge badge-stalled">警告</span>
                  <span className="hygiene-issue-project" title={item.projectId}>
                    {projectNameFallback(item.projectId)}
                  </span>
                  <span className="hygiene-issue-id">{item.pack.name}</span>
                  <span className="hygiene-issue-message">
                    {buildHarnessDriftMessage(item.pack)}
                  </span>
                </div>
                <div className="hygiene-repair">
                  {isConfirming ? (
                    <div className="hygiene-repair-confirm">
                      <button
                        type="button"
                        className="hygiene-repair-confirm-btn"
                        disabled={repairDisabled}
                        onClick={() => handleConfirmHarnessUpdate(item, rowKey)}
                      >
                        {isExecuting ? '実行中…' : '確定: ハーネスを更新'}
                      </button>
                      <button
                        type="button"
                        className="hygiene-repair-cancel"
                        disabled={repairDisabled}
                        onClick={() => setConfirmingRepairKey(null)}
                      >
                        キャンセル
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="hygiene-repair-action"
                      disabled={repairDisabled}
                      onClick={() => beginRepairConfirm(rowKey)}
                    >
                      ハーネスを更新
                    </button>
                  )}
                  {rowError !== null && (
                    <p className="hygiene-repair-error" role="alert">
                      {rowError}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
          {harnessHooksItems.map((item) => {
            const rowKey = harnessHooksRowKey(item);
            const isConfirming = confirmingRepairKey === rowKey;
            const isExecuting = repairDisabled && pendingRepairKey === rowKey;
            const rowError =
              repairError?.rowKey === rowKey ? repairError.message : null;

            return (
              <li key={rowKey}>
                <div className="hygiene-issue-row hygiene-issue-row-static">
                  <span className="hygiene-kind-badge hygiene-kind-harness_hooks">
                    {HARNESS_HOOKS_KIND_LABEL}
                  </span>
                  <span className="badge badge-stalled">警告</span>
                  <span className="hygiene-issue-project" title={item.projectId}>
                    {projectNameFallback(item.projectId)}
                  </span>
                  <span className="hygiene-issue-id">{item.pack.name}</span>
                  <span
                    className="hygiene-issue-message"
                    title={formatHarnessHooksDetail(item.pack)}
                  >
                    {buildHarnessHooksMessage(item.pack)}
                  </span>
                </div>
                <div className="hygiene-repair">
                  {isConfirming ? (
                    <div className="hygiene-repair-confirm">
                      <button
                        type="button"
                        className="hygiene-repair-confirm-btn"
                        disabled={repairDisabled}
                        onClick={() => handleConfirmHarnessUpdate(item, rowKey)}
                      >
                        {isExecuting ? '実行中…' : '確定: hook を登録'}
                      </button>
                      <button
                        type="button"
                        className="hygiene-repair-cancel"
                        disabled={repairDisabled}
                        onClick={() => setConfirmingRepairKey(null)}
                      >
                        キャンセル
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="hygiene-repair-action"
                      disabled={repairDisabled}
                      onClick={() => beginRepairConfirm(rowKey)}
                    >
                      hook を登録
                    </button>
                  )}
                  {rowError !== null && (
                    <p className="hygiene-repair-error" role="alert">
                      {rowError}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
          {harnessContractItems.map((item) => {
            const rowKey = harnessContractRowKey(item);
            const label = formatHarnessContractLabel(item.contract);
            const detail = formatHarnessContractDetail(item.contract);
            const needsTicket = harnessContractNeedsTicket(item.contract);
            const isConfirming = confirmingRepairKey === rowKey;
            const isExecuting = repairDisabled && pendingRepairKey === rowKey;
            const rowError =
              repairError?.rowKey === rowKey ? repairError.message : null;

            return (
              <li key={rowKey}>
                <div className="hygiene-issue-row hygiene-issue-row-static">
                  <span className="hygiene-kind-badge hygiene-kind-harness_contract">
                    {HARNESS_CONTRACT_KIND_LABEL}
                  </span>
                  <span className="badge badge-stalled">警告</span>
                  <span className="hygiene-issue-project" title={item.projectId}>
                    {projectNameFallback(item.projectId)}
                  </span>
                  <span className="hygiene-issue-id">{label}</span>
                  <span
                    className="hygiene-issue-message"
                    title={detail ?? undefined}
                  >
                    {detail}
                  </span>
                </div>
                {needsTicket && (
                  <div className="hygiene-repair">
                    {isConfirming ? (
                      <div className="hygiene-repair-confirm">
                        <button
                          type="button"
                          className="hygiene-repair-confirm-btn"
                          disabled={repairDisabled}
                          onClick={() => handleConfirmContractTicket(item, rowKey)}
                        >
                          {isExecuting ? '実行中…' : '確定: チケットを起票'}
                        </button>
                        <button
                          type="button"
                          className="hygiene-repair-cancel"
                          disabled={repairDisabled}
                          onClick={() => setConfirmingRepairKey(null)}
                        >
                          キャンセル
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="hygiene-repair-action"
                        disabled={repairDisabled}
                        onClick={() => beginRepairConfirm(rowKey)}
                      >
                        チケットを起票
                      </button>
                    )}
                    {rowError !== null && (
                      <p className="hygiene-repair-error" role="alert">
                        {rowError}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
          {hygieneIssues.map((issue) => {
            const rowKey = issueRowKey(issue);

            if (issue.kind === 'dependency_cycle' && issue.cycleTicketIds !== undefined) {
              const cycleTicketIds = issue.cycleTicketIds;
              const cycleEdges = issue.cycleEdges ?? [];
              const rootPath = projectRootPaths?.get(issue.projectId);
              const removalScript = formatDependencyCycleRemovalScript(
                cycleEdges,
                rootPath,
              );

              return (
                <li key={rowKey}>
                  <div className="hygiene-issue-row hygiene-issue-row-static">
                    <span className={kindBadgeClass(issue.kind)}>
                      {KIND_LABELS[issue.kind]}
                    </span>
                    <span className={severityBadgeClass(issue.severity)}>
                      {issue.severity === 'warning' ? '警告' : '情報'}
                    </span>
                    <span className="hygiene-issue-project" title={issue.projectId}>
                      {projectNameFallback(issue.projectId)}
                    </span>
                    <span className="hygiene-issue-message">{issue.message}</span>
                  </div>
                  <div
                    className="hygiene-cycle-tickets"
                    aria-label="循環依存の構成チケット"
                  >
                    {cycleTicketIds.map((ticketId) => (
                      <button
                        key={ticketId}
                        type="button"
                        className="hygiene-cycle-ticket-link"
                        onClick={() => onSelectTicket(ticketId)}
                      >
                        {ticketId}
                      </button>
                    ))}
                  </div>
                  {removalScript.length > 0 && (
                    <div className="hygiene-cleanup">
                      <code className="hygiene-cleanup-command">{removalScript}</code>
                      <button
                        type="button"
                        className="hygiene-cleanup-copy"
                        title="コピーのみ。実行はしません"
                        onClick={() => {
                          void handleCopyCleanup(removalScript);
                        }}
                      >
                        解消コマンドをコピー
                      </button>
                    </div>
                  )}
                </li>
              );
            }

            const cleanupScript = resolveCleanupScript(issue);
            const repairable = getRepairableKind(issue.kind);
            const isConfirming = confirmingRepairKey === rowKey;
            const isExecuting =
              repairDisabled && pendingRepairKey === rowKey;
            const rowError =
              repairError?.rowKey === rowKey ? repairError.message : null;

            return (
              <li key={rowKey}>
                <button
                  type="button"
                  className="hygiene-issue-row"
                  onClick={() => onSelectTicket(issue.ticketId)}
                >
                  <span className={kindBadgeClass(issue.kind)}>
                    {KIND_LABELS[issue.kind]}
                  </span>
                  <span className={severityBadgeClass(issue.severity)}>
                    {issue.severity === 'warning' ? '警告' : '情報'}
                  </span>
                  <span className="hygiene-issue-project" title={issue.projectId}>
                    {projectNameFallback(issue.projectId)}
                  </span>
                  <span className="hygiene-issue-id">{issue.ticketId}</span>
                  <span className="hygiene-issue-message">{issue.message}</span>
                </button>
                {cleanupScript !== null && (
                  <div className="hygiene-cleanup">
                    <code className="hygiene-cleanup-command">{cleanupScript}</code>
                    <button
                      type="button"
                      className="hygiene-cleanup-copy"
                      title="コピーのみ。実行はしません"
                      onClick={() => {
                        void handleCopyCleanup(cleanupScript);
                      }}
                    >
                      掃除コマンドをコピー
                    </button>
                  </div>
                )}
                {repairable !== null && (
                  <div className="hygiene-repair">
                    {isConfirming ? (
                      <div className="hygiene-repair-confirm">
                        <button
                          type="button"
                          className="hygiene-repair-confirm-btn"
                          disabled={repairDisabled}
                          onClick={() => handleConfirmRepair(issue, rowKey)}
                        >
                          {isExecuting
                            ? '実行中…'
                            : confirmRepairLabel(repairable)}
                        </button>
                        <button
                          type="button"
                          className="hygiene-repair-cancel"
                          disabled={repairDisabled}
                          onClick={() => setConfirmingRepairKey(null)}
                        >
                          キャンセル
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="hygiene-repair-action"
                        disabled={repairDisabled}
                        onClick={() => beginRepairConfirm(rowKey)}
                      >
                        {repairActionLabel(repairable)}
                      </button>
                    )}
                    {rowError !== null && (
                      <p className="hygiene-repair-error" role="alert">
                        {rowError}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
