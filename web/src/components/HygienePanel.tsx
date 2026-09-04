import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type {
  HygieneIssueDto,
  HygieneIssueKindDto,
  LeaseHealthDto,
  ProjectHarnessContractDto,
  ProjectHarnessPackStatusDto,
  QuickActionRequest,
  ReclaimProjectStatusDto,
  StaleLeaseDto,
} from '../api';
import {
  fetchAllHarnessStatus,
  fetchHygieneIssues,
  fetchLeaseHealth,
  fetchMergeSlotStatus,
  postProjectHarnessInject,
  postTicketQuickAction,
  postTicketQuickActionUndo,
} from '../api';
import {
  buildWorktreeCleanupCommands,
  copyTextToClipboard,
  formatDependencyCycleRemovalScript,
  formatWorktreeCleanupScript,
} from '../bdCommands';
import { formatActivityTime } from './activityFeedFormatting';
import {
  buildHarnessDriftMessage,
  buildHarnessInjectSuccessMessage,
  formatHarnessContractDetail,
  formatHarnessContractLabel,
  harnessContractNeedsAttention,
} from '../harnessDisplay';
import { useAutoClearedValue } from '../hooks/useAutoClearedValue';
import { planQuickActionUndo } from '../quickActionUndo';
import { describeWriteError } from '../writeAccessMessage';
import { useUndoSnackbar } from './UndoSnackbar';

export interface HygienePanelProps {
  readonly projectIds: readonly string[];
  onSelectTicket: (ticketId: string) => void;
  readonly projectRootPaths?: ReadonlyMap<string, string>;
}

interface HarnessDriftItem {
  readonly projectId: string;
  readonly pack: ProjectHarnessPackStatusDto;
}

interface HarnessContractItem {
  readonly projectId: string;
  readonly contract: ProjectHarnessContractDto;
}

interface HarnessHygieneItems {
  readonly driftItems: readonly HarnessDriftItem[];
  readonly contractItems: readonly HarnessContractItem[];
}

const COPY_FEEDBACK_MS = 2000;
const REPAIR_FEEDBACK_MS = 4000;
const DEFAULT_REPAIR_PRIORITY = 2;
const HARNESS_DRIFT_KIND_LABEL = 'ハーネス要更新';
const HARNESS_CONTRACT_KIND_LABEL = '検証コントラクト';
const STALE_LEASE_KIND_LABEL = 'stale lease（heartbeat 途絶）';
const MERGE_SLOT_KIND_LABEL = 'マージスロット';

const KIND_LABELS: Record<HygieneIssueKindDto, string> = {
  dependency_cycle: '循環依存',
  overdue_defer: '期限超過の保留',
  stale_epic: '完了済みエピック',
  stale_in_progress: '長期 in_progress',
  missing_priority: 'priority 未設定',
  unblocked_high_priority_idle: '着手待ち高優先',
  stale_pending_decision: '放置された確認待ち',
  merged_leftover: '残骸 worktree',
};

type RepairableKind = 'undefer' | 'close' | 'priority';

type RepairFeedback = {
  readonly rowKey: string;
  readonly message: string;
};

function issueRowKey(issue: HygieneIssueDto): string {
  return `${issue.kind}-${issue.ticketId}`;
}

function harnessDriftRowKey(item: HarnessDriftItem): string {
  return `harness-drift-${item.projectId}-${item.pack.name}`;
}

function harnessContractRowKey(item: HarnessContractItem): string {
  return `harness-contract-${item.projectId}`;
}

/**
 * ハーネス由来の警告を1回のリクエストからまとめて作る。
 *
 * 検証コントラクトは**注入済みプロジェクトだけ**が対象で、未注入は
 * サーバー側で `not-applicable` になっている。ここでフィルタし直さないのは、
 * 「どこまでを問題扱いにするか」の判断をサーバーの1か所に集めるため
 * (bdboard-pkr6.3)。
 */
async function fetchHarnessHygieneItems(
  projectIds: readonly string[],
): Promise<HarnessHygieneItems> {
  const batch = await fetchAllHarnessStatus();
  const filterSet = projectIds.length > 0 ? new Set(projectIds) : null;
  const entries = batch.projects.filter(
    (entry) => filterSet === null || filterSet.has(entry.projectId),
  );

  return {
    driftItems: entries.flatMap(({ projectId, packs }) =>
      packs.filter((pack) => pack.drift).map((pack) => ({ projectId, pack })),
    ),
    contractItems: entries
      .filter((entry) => harnessContractNeedsAttention(entry.contract))
      .map(({ projectId, contract }) => ({ projectId, contract })),
  };
}

function getRepairableKind(kind: HygieneIssueKindDto): RepairableKind | null {
  switch (kind) {
    case 'overdue_defer':
      return 'undefer';
    case 'stale_epic':
      return 'close';
    case 'missing_priority':
      return 'priority';
    default:
      return null;
  }
}

function kindBadgeClass(kind: HygieneIssueKindDto): string {
  return `hygiene-kind-badge hygiene-kind-${kind}`;
}

function severityBadgeClass(severity: HygieneIssueDto['severity']): string {
  return severity === 'warning' ? 'badge badge-stalled' : 'badge badge-info';
}

function resolveCleanupScript(issue: HygieneIssueDto): string | null {
  if (issue.cleanup === undefined) {
    return null;
  }
  const commands = buildWorktreeCleanupCommands(issue.cleanup);
  if (commands.length === 0) {
    return null;
  }
  return formatWorktreeCleanupScript(issue.cleanup);
}

function buildRepairRequest(
  issue: HygieneIssueDto,
  priority: number,
): { request: QuickActionRequest; previousDeferUntil?: string } | null {
  const repairable = getRepairableKind(issue.kind);
  if (repairable === null) {
    return null;
  }

  switch (repairable) {
    case 'undefer':
      return {
        request: { action: 'undefer' },
        previousDeferUntil: issue.deferUntil,
      };
    case 'close':
      return { request: { action: 'close' } };
    case 'priority':
      return { request: { action: 'priority', priority } };
  }
}

function repairActionLabel(repairable: RepairableKind): string {
  switch (repairable) {
    case 'undefer':
      return '保留を解除';
    case 'close':
      return 'エピックを完了';
    case 'priority':
      return '優先度を設定';
  }
}

function confirmRepairLabel(repairable: RepairableKind): string {
  return `確定: ${repairActionLabel(repairable)}`;
}

function buildRepairSuccessMessage(
  request: QuickActionRequest,
  ticketId: string,
): string {
  switch (request.action) {
    case 'undefer':
      return `保留を解除しました: ${ticketId}`;
    case 'close':
      return `エピックを完了しました: ${ticketId}`;
    case 'priority':
      return `優先度を P${request.priority} に設定しました: ${ticketId}`;
    default:
      return '';
  }
}

function formatStaleDuration(staleForMs: number): string {
  if (staleForMs < 60_000) {
    return `${Math.max(1, Math.floor(staleForMs / 1000))}秒`;
  }
  if (staleForMs < 60 * 60_000) {
    return `${Math.floor(staleForMs / 60_000)}分`;
  }
  const hours = Math.floor(staleForMs / (60 * 60_000));
  const minutes = Math.floor((staleForMs % (60 * 60_000)) / 60_000);
  if (minutes === 0) {
    return `${hours}時間`;
  }
  return `${hours}時間${minutes}分`;
}

function buildStaleLeaseMessage(staleLease: StaleLeaseDto): string {
  return `lease 失効から ${formatStaleDuration(staleLease.staleForMs)}`;
}

function filterReclaimProjects(
  leaseHealth: LeaseHealthDto | undefined,
  projectIds: readonly string[],
): readonly ReclaimProjectStatusDto[] {
  const projects = leaseHealth?.reclaim.projects ?? [];
  if (projectIds.length === 0) {
    return projects;
  }
  const filterSet = new Set(projectIds);
  return projects.filter((project) => filterSet.has(project.projectId));
}

function formatReclaimProjectLine(status: ReclaimProjectStatusDto): string {
  const parts: string[] = [];
  if (status.lastRunAt !== null) {
    parts.push(`最終実行 ${formatActivityTime(new Date(status.lastRunAt))}`);
  } else {
    parts.push('未実行');
  }
  if (status.reclaimedCountUnknown) {
    parts.push('回収件数不明');
  } else if (status.reclaimedCount !== null) {
    parts.push(`回収 ${status.reclaimedCount}件`);
  }
  return parts.join(' / ');
}

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
    queryFn: () => fetchHygieneIssues(projectIds),
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
  const [priorityByRowKey, setPriorityByRowKey] = useState<
    Record<string, number>
  >({});

  const clearRepairFeedback = useCallback(() => {
    setRepairError(null);
    clearRepairStatusMessage();
  }, [clearRepairStatusMessage]);

  const beginRepairConfirm = useCallback(
    (rowKey: string) => {
      setConfirmingRepairKey(rowKey);
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

  const handleConfirmRepair = useCallback(
    (issue: HygieneIssueDto, rowKey: string) => {
      if (repairMutation.isPending) {
        return;
      }
      const priority = priorityByRowKey[rowKey] ?? DEFAULT_REPAIR_PRIORITY;
      const built = buildRepairRequest(issue, priority);
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
    [priorityByRowKey, repairMutation],
  );

  const handleConfirmHarnessUpdate = useCallback(
    (item: HarnessDriftItem, rowKey: string) => {
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
    repairMutation.isPending || harnessInjectMutation.isPending;
  const harnessDriftItems = harnessDriftQuery.data?.driftItems ?? [];
  const harnessContractItems = harnessDriftQuery.data?.contractItems ?? [];
  const hygieneIssues = query.data ?? [];
  const staleLeases = leaseHealthQuery.data?.staleLeases ?? [];
  const heldMergeSlots = (mergeSlotQuery.data ?? []).filter(
    (status) => status.held,
  );
  const reclaimProjects = filterReclaimProjects(
    leaseHealthQuery.data,
    projectIds,
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
    staleLeases.length > 0 ||
    heldMergeSlots.length > 0;

  return (
    <section className="hygiene-panel" aria-label="ボード健全性">
      <div className="hygiene-panel-header">
        <h2 className="hygiene-panel-title">ボード健全性</h2>
        <p className="hygiene-panel-subtitle">
          台帳の腐りを検知した警告一覧です
        </p>
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

      {isLoading && <p className="loading">読み込み中…</p>}
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
                    <span className="hygiene-issue-project">
                      {staleLease.projectId}
                    </span>
                    <span className="hygiene-issue-id">{staleLease.ticketId}</span>
                    <span className="hygiene-issue-message">
                      {buildStaleLeaseMessage(staleLease)}
                    </span>
                  </button>
                ))}
                <div className="hygiene-reclaim-status" aria-label="自動 reclaim 状況">
                  {leaseHealthQuery.data?.reclaim.enabled === false ? (
                    <p>自動 reclaim は無効です</p>
                  ) : (
                    reclaimProjects.map((projectStatus) => (
                      <p key={projectStatus.projectId}>
                        <span>{projectStatus.projectId}: </span>
                        <span>{formatReclaimProjectLine(projectStatus)}</span>
                        {projectStatus.lastError !== null && (
                          <span className="hygiene-reclaim-status-error">
                            {' '}
                            / エラー: {projectStatus.lastError}
                          </span>
                        )}
                      </p>
                    ))
                  )}
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
                    <span className="hygiene-issue-project">
                      {status.projectId}
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
                  <span className="hygiene-issue-project">{item.projectId}</span>
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
          {harnessContractItems.map((item) => {
            const rowKey = harnessContractRowKey(item);
            const label = formatHarnessContractLabel(item.contract);
            const detail = formatHarnessContractDetail(item.contract);

            return (
              <li key={rowKey}>
                <div className="hygiene-issue-row hygiene-issue-row-static">
                  <span className="hygiene-kind-badge hygiene-kind-harness_contract">
                    {HARNESS_CONTRACT_KIND_LABEL}
                  </span>
                  <span className="badge badge-stalled">警告</span>
                  <span className="hygiene-issue-project">{item.projectId}</span>
                  <span className="hygiene-issue-id">{label}</span>
                  <span
                    className="hygiene-issue-message"
                    title={detail ?? undefined}
                  >
                    {detail}
                  </span>
                </div>
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
                    <span className="hygiene-issue-project">{issue.projectId}</span>
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
            const selectedPriority =
              priorityByRowKey[rowKey] ?? DEFAULT_REPAIR_PRIORITY;

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
                  <span className="hygiene-issue-project">{issue.projectId}</span>
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
                    {repairable === 'priority' && (
                      <label className="hygiene-repair-priority">
                        <span className="hygiene-repair-priority-label">優先度</span>
                        <select
                          value={selectedPriority}
                          disabled={repairDisabled}
                          onChange={(event) => {
                            setPriorityByRowKey((current) => ({
                              ...current,
                              [rowKey]: Number(event.target.value),
                            }));
                          }}
                        >
                          {[0, 1, 2, 3, 4].map((priority) => (
                            <option key={priority} value={priority}>
                              P{priority}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
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
