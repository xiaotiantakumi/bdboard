// bdboard-sso1.12: dto.ts のモジュール分割。Hygiene パネルが検出する問題
// (依存サイクル・期限超過・停滞・ハートビートループ・衝突ファイル等) の DTO。
// hygiene-routes.ts が参照する (barrel 経由)。lease/merge-slot/PR バッジの
// ステータス系は hygiene-status.ts、依存グラフは dependency-graph.ts に分けている。
import type { HygieneIssue } from '../../../domain/hygiene.js';
import type { NonTicketHarnessWorktreeWarning } from '../../../domain/non-ticket-harness-worktree.js';

export type HygieneIssueKindDto =
  | 'dependency_cycle'
  | 'overdue_defer'
  | 'stale_epic'
  | 'stale_in_progress'
  | 'unblocked_high_priority_idle'
  | 'stale_pending_decision'
  | 'merged_leftover'
  | 'reclaimed_live_worktree'
  | 'stale_harness_worktree'
  | 'orphan_heartbeat_loop'
  | 'in_flight_file_overlap'
  | 'closed_without_evidence';

export interface HygieneCycleEdgeDto {
  issueId: string;
  dependsOnId: string;
}

export interface HygieneOverlapPeerDto {
  otherTicketId: string;
  files: string[];
}

export interface HygieneCleanupTargetDto {
  repoRootPath: string;
  worktreePath: string | null;
  branchName: string | null;
}

export interface HygieneHeartbeatLoopTargetDto {
  pid: number;
  ticketIds: string[];
  sessionPid?: number;
  startedAt?: string;
  reason: 'all_closed' | 'session_gone';
}

export interface HygieneIssueDto {
  kind: HygieneIssueKindDto;
  ticketId: string;
  projectId: string;
  message: string;
  severity: 'warning' | 'info';
  cleanup?: HygieneCleanupTargetDto;
  heartbeatLoop?: HygieneHeartbeatLoopTargetDto;
  deferUntil?: string;
  cycleTicketIds?: string[];
  cycleEdges?: HygieneCycleEdgeDto[];
  overlaps?: HygieneOverlapPeerDto[];
}

/** close 証拠チェックの確認状況 (bdboard-pkr6.8)。 */
export interface HygieneCloseEvidenceStatusDto {
  /**
   * コメント本文をまだ確認できていないチケット数。
   *
   * bd comments が高いので1リクエストあたりの新規フェッチには時間予算があり、
   * 溢れたぶんは未確認として検出を見送っている。0 でないレスポンスは
   * 「問題が無い」ではなく「まだ全部見ていない」なので、UI とログに出す。
   */
  unknownCount: number;
}

/**
 * `bd/<id>` に紐づかない worktree (feature/* 等) のハーネス凍結警告 1 件ぶん。
 * `HygieneIssueDto` と違い ticketId を持たない (bdboard-wadg)。
 */
export interface NonTicketHarnessWorktreeWarningDto {
  projectId: string;
  worktreePath: string;
  branchName: string;
  commitsBehind: number;
  baseRef: string;
  message: string;
}

export interface HygieneResponseDto {
  issues: HygieneIssueDto[];
  /** commentReader が無く検査自体を行っていないときは null。 */
  closeEvidence: HygieneCloseEvidenceStatusDto | null;
  /**
   * 非チケット worktree のハーネス凍結。以下のいずれかでも空 []: scanner が遅れを
   * 測れない構成のとき / 生存セッション (cwd がその worktree の内側にある alive な
   * セッション) が1つも無いとき (bdboard-cjsa)。
   */
  nonTicketHarnessWorktrees: NonTicketHarnessWorktreeWarningDto[];
}

export function toHygieneIssueDto(issue: HygieneIssue): HygieneIssueDto {
  return {
    kind: issue.kind,
    ticketId: issue.ticketId,
    projectId: issue.projectId,
    message: issue.message,
    severity: issue.severity,
    ...(issue.cleanup !== undefined
      ? {
          cleanup: {
            repoRootPath: issue.cleanup.repoRootPath,
            worktreePath: issue.cleanup.worktreePath,
            branchName: issue.cleanup.branchName,
          },
        }
      : {}),
    ...(issue.heartbeatLoop !== undefined
      ? {
          heartbeatLoop: {
            pid: issue.heartbeatLoop.pid,
            ticketIds: [...issue.heartbeatLoop.ticketIds],
            reason: issue.heartbeatLoop.reason,
            ...(issue.heartbeatLoop.sessionPid !== undefined
              ? { sessionPid: issue.heartbeatLoop.sessionPid }
              : {}),
            ...(issue.heartbeatLoop.startedAt !== undefined
              ? { startedAt: issue.heartbeatLoop.startedAt }
              : {}),
          },
        }
      : {}),
    ...(issue.deferUntil !== undefined ? { deferUntil: issue.deferUntil } : {}),
    ...(issue.cycleTicketIds !== undefined
      ? { cycleTicketIds: [...issue.cycleTicketIds] }
      : {}),
    ...(issue.cycleEdges !== undefined
      ? {
          cycleEdges: issue.cycleEdges.map((edge) => ({
            issueId: edge.issueId,
            dependsOnId: edge.dependsOnId,
          })),
        }
      : {}),
    ...(issue.overlaps !== undefined
      ? {
          overlaps: issue.overlaps.map((peer) => ({
            otherTicketId: peer.otherTicketId,
            files: [...peer.files],
          })),
        }
      : {}),
  };
}

export function toNonTicketHarnessWorktreeWarningDto(
  warning: NonTicketHarnessWorktreeWarning,
): NonTicketHarnessWorktreeWarningDto {
  return {
    projectId: warning.projectId,
    worktreePath: warning.worktreePath,
    branchName: warning.branchName,
    commitsBehind: warning.commitsBehind,
    baseRef: warning.baseRef,
    message: warning.message,
  };
}
