import { fetchJson } from './http';

export interface PendingDecisionDwellKpiDto {
  /** 確認待ちのまま close された件数 (期間内) */
  closedCount: number;
  closedGateCount: number;
  closedWorkCount: number;
  /** 未クローズの確認待ち件数。期間によらない現在値 */
  openCount: number;
  openGateCount: number;
  openWorkCount: number;
  medianMs: number | null;
  p90Ms: number | null;
  /** 'created' = ラベル付与時刻が取れないので作成時刻で代替している */
  anchor: 'created';
}

export interface ReclaimKpiDto {
  runCount: number;
  reclaimedCountTotal: number;
  unknownCountRunCount: number;
  identifiedTicketCount: number;
  reclaimedThenInProgressCount: number;
  reclaimedThenInProgressRate: number | null;
  windowMs: number;
  /** この統計が「いつ以降」のものか。永続化していない */
  since: string | null;
  /** 出力を読めず履歴に積めなかった実行の累積回数 */
  unparsedRunCount: number;
  /**
   * 誤回収件数。identifiedTicketCount のうち、いま worktree/ブランチが残って
   * いる数。git を読めなかった (スキャン不完全 / 未設定) なら null — UI は — を出す
   */
  reclaimedLiveWorktreeCount: number | null;
  /** 母数 (identifiedTicketCount) が 0、またはスキャンが不完全なら null */
  reclaimedLiveWorktreeRate: number | null;
}

export interface HarnessShareKpiDto {
  matchedCount: number;
  totalCount: number;
  rate: number | null;
}

export interface HarnessKpiDto {
  rangeStart: string;
  rangeEnd: string;
  pendingDecisionDwell: PendingDecisionDwellKpiDto;
  reclaim: ReclaimKpiDto;
  harnessLabeled: HarnessShareKpiDto;
  duplicateMention: HarnessShareKpiDto;
}

export function fetchHarnessKpi(
  weeks = 8,
  projectIds: readonly string[] = [],
): Promise<HarnessKpiDto> {
  const searchParams = new URLSearchParams();
  searchParams.set('weeks', String(weeks));
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  return fetchJson<HarnessKpiDto>(`/api/harness-kpi?${searchParams.toString()}`);
}

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
  /** overdue_defer のときだけ入る。Undo で元の日付へ再 defer するための材料。サーバーがローカルタイムゾーンで `YYYY-MM-DD` に整形済み */
  deferUntil?: string;
  cycleTicketIds?: string[];
  cycleEdges?: HygieneCycleEdgeDto[];
  /** in_flight_file_overlap のときだけ入る。相手チケットと重複しているファイル */
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
 * `bd/<id>` に紐づかない worktree (Claude Code の `isolation: "worktree"` が作る
 * `feature/<slug>` 等) のハーネス凍結警告。ticketId を持たないため HygieneIssueDto
 * には乗らず、`issues` とは別枠で返す (bdboard-wadg)。
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

export function fetchHygiene(
  projectIds: readonly string[] = [],
): Promise<HygieneResponseDto> {
  const searchParams = new URLSearchParams();
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  const query = searchParams.toString();
  const path = query.length > 0 ? `/api/hygiene?${query}` : '/api/hygiene';
  return fetchJson<HygieneResponseDto>(path);
}

export interface StaleLeaseDto {
  ticketId: string;
  projectId: string;
  leaseExpiresAt: string;
  staleForMs: number;
}

export interface ReclaimProjectStatusDto {
  projectId: string;
  lastRunAt: string | null;
  reclaimedCount: number | null;
  reclaimedCountUnknown: boolean;
  rawSummary: string | null;
  lastError: string | null;
}

export interface ReclaimSchedulerStatusDto {
  enabled: boolean;
  intervalMs: number;
  olderThan: string;
  projects: ReclaimProjectStatusDto[];
}

export interface LeaseHealthDto {
  staleLeases: StaleLeaseDto[];
  reclaim: ReclaimSchedulerStatusDto;
}

export function fetchLeaseHealth(
  projectIds: readonly string[] = [],
): Promise<LeaseHealthDto> {
  const searchParams = new URLSearchParams();
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  const query = searchParams.toString();
  const path = query.length > 0 ? `/api/lease-health?${query}` : '/api/lease-health';
  return fetchJson<LeaseHealthDto>(path);
}

export interface MergeSlotStatusDto {
  projectId: string;
  present: boolean;
  held: boolean;
  holder: string | null;
  heldSinceIso: string | null;
  heldForMs: number;
  isLongHeld: boolean;
}

export function fetchMergeSlotStatus(
  projectIds: readonly string[] = [],
): Promise<MergeSlotStatusDto[]> {
  const searchParams = new URLSearchParams();
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  const query = searchParams.toString();
  const path =
    query.length > 0 ? `/api/merge-slot-status?${query}` : '/api/merge-slot-status';
  return fetchJson<MergeSlotStatusDto[]>(path);
}
