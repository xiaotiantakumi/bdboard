// bdboard-sso1.11: HygienePanel.tsx から issue 表示・修復関連の純粋関数を移動
// しただけのファイル。挙動は一切変えていない。
import type {
  HygieneIssueDto,
  HygieneIssueKindDto,
  QuickActionRequest,
} from '../../api';
import {
  buildWorktreeCleanupCommands,
  formatHeartbeatLoopKillScript,
  formatWorktreeCleanupScript,
} from '../../bdCommands';
import type { RepairableKind } from './types';

export function getRepairableKind(kind: HygieneIssueKindDto): RepairableKind | null {
  switch (kind) {
    case 'overdue_defer':
      return 'undefer';
    case 'stale_epic':
      return 'close';
    default:
      return null;
  }
}

export function kindBadgeClass(kind: HygieneIssueKindDto): string {
  return `hygiene-kind-badge hygiene-kind-${kind}`;
}

export function severityBadgeClass(severity: HygieneIssueDto['severity']): string {
  return severity === 'warning' ? 'badge badge-stalled' : 'badge badge-info';
}

export function resolveCleanupScript(issue: HygieneIssueDto): string | null {
  if (issue.heartbeatLoop !== undefined) {
    const script = formatHeartbeatLoopKillScript({
      pid: issue.heartbeatLoop.pid,
      ...(issue.heartbeatLoop.startedAt !== undefined
        ? { startedAt: issue.heartbeatLoop.startedAt }
        : {}),
    });
    return script.length > 0 ? script : null;
  }
  if (issue.cleanup === undefined) {
    return null;
  }
  const commands = buildWorktreeCleanupCommands(issue.cleanup);
  if (commands.length === 0) {
    return null;
  }
  return formatWorktreeCleanupScript(issue.cleanup);
}

export function buildRepairRequest(
  issue: HygieneIssueDto,
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
  }
}

export function repairActionLabel(repairable: RepairableKind): string {
  switch (repairable) {
    case 'undefer':
      return '保留を解除';
    case 'close':
      return 'エピックを完了';
  }
}

export function confirmRepairLabel(repairable: RepairableKind): string {
  return `確定: ${repairActionLabel(repairable)}`;
}

export function buildRepairSuccessMessage(
  request: QuickActionRequest,
  ticketId: string,
): string {
  switch (request.action) {
    case 'undefer':
      return `保留を解除しました: ${ticketId}`;
    case 'close':
      return `エピックを完了しました: ${ticketId}`;
    default:
      return '';
  }
}
