// bdboard-sso1.11: HygienePanel.tsx から汎用 hygiene issue 行 (循環依存を含む)
// の表示専用 JSX を移動しただけのファイル。挙動は一切変えていない。確認欄の
// 開閉・実行状態は引き続き親の state/mutation が持ち、ここは props 経由で
// 受け取るだけ。
import type { HygieneIssueDto } from '../../api';
import { formatDependencyCycleRemovalScript } from '../../bdCommands';
import { KIND_LABELS } from './constants';
import {
  getRepairableKind,
  kindBadgeClass,
  repairActionLabel,
  confirmRepairLabel,
  resolveCleanupScript,
  severityBadgeClass,
} from './issueDisplay';
import { issueRowKey } from './rowKeys';
import type { RepairFeedback } from './types';
import { projectNameFallback } from '../../api';

export function HygieneIssueRows({
  issues,
  projectRootPaths,
  confirmingRepairKey,
  pendingRepairKey,
  repairError,
  repairDisabled,
  onSelectTicket,
  onBeginRepairConfirm,
  onConfirmRepair,
  onCancelConfirm,
  onCopyCleanup,
}: {
  readonly issues: readonly HygieneIssueDto[];
  readonly projectRootPaths?: ReadonlyMap<string, string>;
  readonly confirmingRepairKey: string | null;
  readonly pendingRepairKey: string | null;
  readonly repairError: RepairFeedback | null;
  readonly repairDisabled: boolean;
  readonly onSelectTicket: (ticketId: string) => void;
  readonly onBeginRepairConfirm: (rowKey: string) => void;
  readonly onConfirmRepair: (issue: HygieneIssueDto, rowKey: string) => void;
  readonly onCancelConfirm: () => void;
  readonly onCopyCleanup: (script: string) => void;
}) {
  return (
    <>
      {issues.map((issue) => {
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
                      onCopyCleanup(removalScript);
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
                    onCopyCleanup(cleanupScript);
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
                      onClick={() => onConfirmRepair(issue, rowKey)}
                    >
                      {isExecuting
                        ? '実行中…'
                        : confirmRepairLabel(repairable)}
                    </button>
                    <button
                      type="button"
                      className="hygiene-repair-cancel"
                      disabled={repairDisabled}
                      onClick={onCancelConfirm}
                    >
                      キャンセル
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="hygiene-repair-action"
                    disabled={repairDisabled}
                    onClick={() => onBeginRepairConfirm(rowKey)}
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
    </>
  );
}
