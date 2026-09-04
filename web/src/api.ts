import type { Liveness } from './liveness';

export interface ProjectDto {
  id: string;
  name: string;
  rootPath: string;
  prefixes: string[];
  sessionCount: number;
  activeSessionCount: number;
  incompleteTicketCount: number;
  sessions: SessionDto[];
}

export interface StatusDto {
  lastRefreshAt: string | null;
  errors: { kind: string; projectId: string; detail: string }[];
  projectCount: number;
  /** Set only when BDBOARD_TIMEZONE overrides the host timezone. */
  boardTimeZone: string | null;
}

export interface TicketSummaryDto {
  id: string;
  projectId: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  closedAt?: string;
  deferUntil?: string;
  assignee?: string;
  owner?: string;
  parentId?: string;
  commentCount: number;
  labels?: string[];
}

export interface SessionDto {
  sessionId: string;
  pid: number;
  cwd: string;
  alive: boolean;
  startedAt: string;
  lastActivityAt: string;
  liveness: Liveness;
  name?: string;
}

export interface SessionHistoryTicketDto {
  ticketId: string;
  title?: string;
}

export interface SessionHistoryEntryDto {
  session: SessionDto;
  projectId?: string;
  projectName?: string;
  tickets: SessionHistoryTicketDto[];
}

export interface SessionTailMessageDto {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface SessionTailDto {
  sessionId: string;
  messages: SessionTailMessageDto[];
}

export interface AgentProcessDto {
  pid: number;
  command: string;
  cwd: string;
  startedAt?: string;
  projectId?: string;
  projectName?: string;
}

export interface BoardCardDto {
  ticket: TicketSummaryDto;
  lane: string;
  projectId: string;
  blockedBy: string[];
  blocks: string[];
  unblocksCount: number;
  liveness: string | null;
  sessions: SessionDto[];
  stalled: boolean;
  epicProgress: { total: number; done: number } | null;
  deferDays: number | null;
  deferUrgency: 'overdue' | 'today' | 'soon' | 'later' | null;
  effectivePriority: number;
  priorityInheritedFrom: string | null;
}

export interface BoardDto {
  lanes: Record<string, BoardCardDto[]>;
  cardCount: number;
  /**
   * done(closed) レーンの切り捨て前の総件数。サーバー側の closedLimit(既定100件/
   * プロジェクト)を超えると lanes.done.length より大きくなる — その差分が
   * 「他 N 件 (非表示)」の件数(bdboard-3tw.86)。
   */
  closedTotal: number;
  /**
   * closedLimit で切り捨てられ、lanes.done には出てこないチケットのID一覧
   * (カード全体ではなくIDのみ)。既知ID自動リンク判定(App.tsx の boardTicketIds →
   * isTicketOnBoard)がこれも「ボード上に存在する」として拾うために使う
   * (bdboard-3tw.86 回帰対応)。
   */
  truncatedClosedIds: string[];
}

export interface ProjectBoardDto {
  project: ProjectDto;
  board: BoardDto;
}

export interface BoardViewDto {
  mode: string;
  generatedAt: string;
  projects: ProjectBoardDto[];
  merged: BoardDto | null;
}

export interface DependencyEdgeDto {
  issueId: string;
  dependsOnId: string;
  kind: string;
}

/**
 * source: 'metadata' は bdboard.session メタデータ経由の手動リンク、
 * 'transcript' はトランスクリプトからの自動推定リンク(bdboard-3tw.9)。
 */
export interface TicketSessionLinkDto {
  sessionId: string;
  source: 'metadata' | 'transcript';
}

/** `bdboard.model.<工程>` メタデータ由来の、工程ごとの使用モデル。 */
export interface TicketModelDto {
  stage: string;
  model: string;
}

export interface TicketDetailDto extends TicketSummaryDto {
  description?: string;
  notes?: string;
  dependencies: DependencyEdgeDto[];
  blockedBy: string[];
  blocks: string[];
  usage?: TicketTokenUsageDto;
  sessionLinks: TicketSessionLinkDto[];
  models: TicketModelDto[];
  children: TicketChildDto[];
}

export interface TicketChildDto {
  id: string;
  title: string;
  lane: Lane;
}

export interface ModelUsageDto {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface TicketTokenUsageDto {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  byModel: ModelUsageDto[];
}

export interface CommentDto {
  id: string;
  issueId: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface TicketSearchResultDto {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
}

export interface TicketSimilarResultDto {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  score: number;
}

export interface ActivityEventDto {
  kind:
    | 'created'
    | 'started'
    | 'closed'
    | 'status_changed'
    | 'priority_changed'
    | 'field_changed';
  at: string;
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  actor?: string;
  reason?: string;
  from?: string;
  to?: string;
}

export interface WeeklyCloseCountDto {
  weekStart: string;
  count: number;
}

export interface AgeDistributionDto {
  d0to1: number;
  d1to7: number;
  d7to30: number;
  d30plus: number;
}

export interface ProjectThroughputStatsDto {
  projectId: string;
  projectName: string;
  weeklyCloses: WeeklyCloseCountDto[];
  openTicketAge: AgeDistributionDto;
}

export interface ThroughputStatsDto {
  projects: ProjectThroughputStatsDto[];
  totals: {
    weeklyCloses: WeeklyCloseCountDto[];
    openTicketAge: AgeDistributionDto;
  };
}

export interface WeeklyModelCloseCountsDto {
  weekStart: string;
  counts: Record<string, number>;
}

export interface StageModelCountsDto {
  stage: string;
  counts: Record<string, number>;
}

export interface ModelStatsDto {
  weeklyCloses: WeeklyModelCloseCountsDto[];
  stageModelDistribution: StageModelCountsDto[];
}

export interface CfdDayEntryDto {
  date: string;
  counts: Record<string, number>;
}

export interface ProjectCfdStatsDto {
  projectId: string;
  projectName: string;
  days: CfdDayEntryDto[];
}

export interface CfdStatsDto {
  projects: ProjectCfdStatsDto[];
  totals: CfdDayEntryDto[];
}

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

export type HygieneIssueKindDto =
  | 'dependency_cycle'
  | 'overdue_defer'
  | 'stale_epic'
  | 'stale_in_progress'
  | 'unblocked_high_priority_idle'
  | 'stale_pending_decision'
  | 'merged_leftover'
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

export interface HygieneIssueDto {
  kind: HygieneIssueKindDto;
  ticketId: string;
  projectId: string;
  message: string;
  severity: 'warning' | 'info';
  cleanup?: HygieneCleanupTargetDto;
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

export interface HygieneResponseDto {
  issues: HygieneIssueDto[];
  /** commentReader が無く検査自体を行っていないときは null。 */
  closeEvidence: HygieneCloseEvidenceStatusDto | null;
}

/** チケット詳細パネルの「衝突しうる着手中チケット」1 行ぶん */
export interface TicketInFlightOverlapDto {
  ticketId: string;
  files: string[];
}

export interface PendingDecisionDto {
  id: string;
  kind: 'gate' | 'ticket';
  projectId: string;
  question?: string;
  options?: { label: string; value: string }[];
  allowFreeform: boolean;
}

export interface TicketDecisionOutcome {
  kind: 'gate' | 'ticket' | 'unknown';
  closed: boolean;
}

export type BoardMode = 'merged' | 'split';

// 列の表示順は「着手可能 → 進行中 → 確認待ち → ブロック → 完了」(bdboard-662)。この配列の
// 並びがそのままレーン列の表示順になる(BoardView.tsx の visibleLanes 参照)。サーバー側の
// LANES (src/domain/readiness.ts)と値の集合を必ず一致させること(web は src を import
// できないため、独立に2箇所で定義している)。
//
// bdboard-662: 「保留(deferred)」は独立レーンを持たず「ブロック(blocked)」に表示統合される。
// bd 上の status は 'deferred' のまま変更しない(defer_until の情報や bd ready の除外挙動を
// 壊さないため)。カードの deferDays/deferUrgency 表示は lane==='blocked' の条件で維持する
// (LaneColumn.tsx の showDeferCountdown 参照)。
export const LANES = ['ready', 'in_progress', 'awaiting_human', 'blocked', 'done'] as const;
export type Lane = (typeof LANES)[number];

export const LANE_LABELS: Record<Lane, string> = {
  ready: '着手可能',
  in_progress: '進行中',
  awaiting_human: '確認待ち',
  blocked: 'ブロック',
  done: '完了',
};

// bd 組み込みの hooked は「エージェントの hook に紐づく＝作業中」、pinned は「先頭固定の未完了＝open 相当」
// なのでサーバ側の deriveLane はそれぞれ in_progress / ready へ載せる。ここに含めないと正常な
// チケットに食い違いバッジが出てしまう。
// awaiting_human は bd の human ラベルという status とは独立の軸で決まる派生レーンなので、
// どの status が来ても「食い違い」ではない。あえてキーを設けず、isLaneStatusMismatch 側で
// 未定義=判定スキップとして扱う(常にバッジ非表示)。
// blocked は bdboard-662 で保留(deferred)を吸収したため、bd status 'blocked' に加えて
// 'deferred' も期待値に含める(そうしないと保留チケット全件に食い違いバッジが出てしまう)。
// 依存関係由来で自動的にブロック扱いになったチケット(status は 'open' のまま)は従来どおり
// 食い違いとして扱う(意図的な既存挙動)。
export const LANE_EXPECTED_STATUS: Partial<Record<Lane, readonly string[]>> = {
  in_progress: ['in_progress', 'hooked'],
  blocked: ['blocked', 'deferred'],
  ready: ['open', 'ready', 'pinned'],
  done: ['closed', 'done'],
};

export class ApiError extends Error {
  readonly status: number;
  readonly body?: string;
  readonly errorMessage?: string;
  readonly detail?: string;
  /** スキャンルート拒否などの追加情報。サーバーのレスポンスをそのまま保持する(bdboard-mmb)。 */
  readonly details?: unknown;
  /**
   * chat エージェント失敗コード(例: 'agent-workspace-untrusted')。サーバーの
   * agent-error レスポンス(502)は `{ error, code, detail }` を返す(chat-routes.ts)。
   * `code` はここまで運ばれず ChatPanel が定型文にマップできなかった
   * (bdboard-l1t.5 Opus 再レビュー DF1)。他のエンドポイントは code を返さないので
   * 常に undefined になり得る。
   */
  readonly code?: string;
  /**
   * 機械可読な失敗理由(例: 'worktree-dirty' / 'already-running')。
   * `error` の人間向け文言はパスなどの可変部分を含むため、クライアントは
   * こちらで分岐する。返さないエンドポイントでは undefined。
   */
  readonly reason?: string;

  constructor(
    status: number,
    message: string,
    options?: {
      body?: string;
      errorMessage?: string;
      detail?: string;
      code?: string;
      reason?: string;
      details?: unknown;
    },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = options?.body;
    this.errorMessage = options?.errorMessage;
    this.detail = options?.detail;
    this.code = options?.code;
    this.reason = options?.reason;
    this.details = options?.details;
  }
}

async function readErrorPayload(res: Response): Promise<{
  body: string;
  errorMessage?: string;
  detail?: string;
  code?: string;
  reason?: string;
  details?: unknown;
}> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      detail?: unknown;
      code?: unknown;
      reason?: unknown;
      details?: unknown;
    };
    const errorMessage =
      typeof parsed.error === 'string' ? parsed.error : undefined;
    const detail =
      typeof parsed.detail === 'string' ? parsed.detail : undefined;
    const code = typeof parsed.code === 'string' ? parsed.code : undefined;
    const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
    const details = parsed.details;
    if (
      errorMessage !== undefined ||
      detail !== undefined ||
      code !== undefined ||
      reason !== undefined ||
      details !== undefined
    ) {
      return { body, errorMessage, detail, code, reason, details };
    }
  } catch {
    // non-JSON error body
  }
  return { body };
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const { body, errorMessage, detail, code, reason, details } =
      await readErrorPayload(res);
    throw new ApiError(
      res.status,
      errorMessage ?? `HTTP ${res.status} ${res.statusText}: ${path}`,
      { body, errorMessage, detail, code, reason, details },
    );
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export interface ScanRootsConfigDto {
  scanRoots: string[];
  excludePaths: string[];
  version: string;
  envOverride: boolean;
  defaultScanRoots: string[];
  envScanRoots: string[];
}

export function fetchScanRootsConfig(): Promise<ScanRootsConfigDto> {
  return fetchJson<ScanRootsConfigDto>('/api/settings/scan-roots');
}

export function putScanRootsConfig(config: {
  scanRoots: string[];
  excludePaths: string[];
  version: string;
}): Promise<{ scanRoots: string[]; excludePaths: string[]; version: string }> {
  return fetchJson<{ scanRoots: string[]; excludePaths: string[]; version: string }>('/api/settings/scan-roots', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export interface BoardThresholdsConfigDto {
  stalledAfterMs: number;
  livenessActiveMs: number;
  livenessIdleMs: number;
  livenessStaleMs: number;
  inProgressWipLimit: number | null;
  inProgressWipLimitByProject: Record<string, number>;
  version: string;
  defaults: {
    stalledAfterMs: number;
    livenessActiveMs: number;
    livenessIdleMs: number;
    livenessStaleMs: number;
    inProgressWipLimit: number | null;
    inProgressWipLimitByProject: Record<string, number>;
  };
}

export function fetchBoardThresholdsConfig(): Promise<BoardThresholdsConfigDto> {
  return fetchJson<BoardThresholdsConfigDto>('/api/settings/board-thresholds');
}

export function putBoardThresholdsConfig(config: {
  stalledAfterMs?: number;
  livenessActiveMs?: number;
  livenessIdleMs?: number;
  livenessStaleMs?: number;
  inProgressWipLimit?: number | null;
  inProgressWipLimitByProject?: Record<string, number>;
  version: string;
}): Promise<BoardThresholdsConfigDto> {
  return fetchJson<BoardThresholdsConfigDto>('/api/settings/board-thresholds', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export interface HygieneThresholdsConfigDto {
  staleInProgressAfterMs: number;
  highPriorityMax: number;
  stalePendingDecisionAfterMs: number;
  closedWithoutEvidenceWindowMs: number;
  version: string;
  defaults: {
    staleInProgressAfterMs: number;
    highPriorityMax: number;
    stalePendingDecisionAfterMs: number;
    closedWithoutEvidenceWindowMs: number;
  };
}

export function fetchHygieneThresholdsConfig(): Promise<HygieneThresholdsConfigDto> {
  return fetchJson<HygieneThresholdsConfigDto>('/api/settings/hygiene-thresholds');
}

export function putHygieneThresholdsConfig(config: {
  staleInProgressAfterMs?: number;
  highPriorityMax?: number;
  stalePendingDecisionAfterMs?: number;
  closedWithoutEvidenceWindowMs?: number;
  version: string;
}): Promise<HygieneThresholdsConfigDto> {
  return fetchJson<HygieneThresholdsConfigDto>('/api/settings/hygiene-thresholds', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export interface DbStatsDto {
  sizeBytes: number;
  tables: { name: string; rowCount: number }[];
}

export function fetchDbStats(): Promise<DbStatsDto> {
  return fetchJson<DbStatsDto>('/api/settings/db-stats');
}

export interface AiQuotaAlertConfigDto {
  thresholdPercent: number;
  version: string;
  defaults: { thresholdPercent: number };
}

export function fetchAiQuotaAlertConfig(): Promise<AiQuotaAlertConfigDto> {
  return fetchJson<AiQuotaAlertConfigDto>('/api/settings/ai-quota-alert');
}

export function putAiQuotaAlertConfig(config: {
  thresholdPercent: number;
  version: string;
}): Promise<AiQuotaAlertConfigDto> {
  return fetchJson<AiQuotaAlertConfigDto>('/api/settings/ai-quota-alert', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export interface AgentRunConfigDto {
  allowRemoteAgentRuns: boolean;
  defaults: { allowRemoteAgentRuns: boolean };
  version: string;
}

export type AgentRunStatusDto =
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface AgentRunSummaryDto {
  id: string;
  ticketId: string;
  runner: string;
  mode: 'spawn' | 'resume';
  status: AgentRunStatusDto;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
}

/**
 * run 完了後に人が run の外で回す検証コマンド (bdboard-pkr6.11)。
 * 実行中の run と、前提が崩れているプロジェクトでは返らない。
 */
export interface AgentRunNextStepDto {
  verify: string;
  worktreePath: string;
}

/** ログと cwd はローカル画面からのみ返る (M-1)。リモートでは logRestricted が true。 */
export interface AgentRunDetailDto extends AgentRunSummaryDto {
  cwd?: string;
  log: string;
  logRestricted?: boolean;
  /** worktree の絶対パスを含むので cwd と同じくローカル限定。 */
  nextStep?: AgentRunNextStepDto;
}

export interface StartAgentRunResponseDto {
  runId: string;
  ticketId: string;
  status: 'pending';
  worktreePath: string;
  branchName: string;
  /** 既存の worktree を再利用したか（false なら新規作成）。 */
  reused: boolean;
  /**
   * 実行は止めなかったが伝えるべきこと。現状は `harness-drift`
   * (ハーネスパックが古い) のみ (bdboard-pkr6.11)。
   *
   * 現状 UI では未使用（drift はバッジ側で可視）。
   */
  warnings?: string[];
}

export function fetchAgentRunConfig(): Promise<AgentRunConfigDto> {
  return fetchJson<AgentRunConfigDto>('/api/settings/agent-runs');
}

export function saveAgentRunConfig(config: {
  allowRemoteAgentRuns: boolean;
  version: string;
}): Promise<AgentRunConfigDto> {
  return fetchJson<AgentRunConfigDto>('/api/settings/agent-runs', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export function startTicketRun(ticketId: string): Promise<StartAgentRunResponseDto> {
  return fetchJson<StartAgentRunResponseDto>('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticketId }),
  });
}

export function fetchTicketRuns(ticketId: string): Promise<{ runs: AgentRunSummaryDto[] }> {
  const searchParams = new URLSearchParams({ ticketId });
  return fetchJson<{ runs: AgentRunSummaryDto[] }>(`/api/runs?${searchParams.toString()}`);
}

export function fetchAgentRun(
  runId: string,
  tailBytes?: number,
): Promise<AgentRunDetailDto> {
  const searchParams = new URLSearchParams();
  if (tailBytes !== undefined) {
    searchParams.set('tailBytes', String(tailBytes));
  }
  const query = searchParams.toString();
  const path = `/api/runs/${encodeURIComponent(runId)}${
    query.length > 0 ? `?${query}` : ''
  }`;
  return fetchJson<AgentRunDetailDto>(path);
}

export function cancelAgentRun(
  runId: string,
): Promise<{ runId: string; status: AgentRunStatusDto }> {
  return fetchJson<{ runId: string; status: AgentRunStatusDto }>(
    `/api/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST' },
  );
}

export function postRefresh(): Promise<void> {
  return fetchJson<{ ok: boolean }>('/api/refresh', { method: 'POST' }).then(() => undefined);
}

export function fetchProjects(): Promise<ProjectDto[]> {
  return fetchJson<ProjectDto[]>('/api/projects');
}

export function fetchSessions(): Promise<SessionDto[]> {
  return fetchJson<SessionDto[]>('/api/sessions');
}

export function fetchSessionHistory(
  limit?: number,
  projectId?: string,
): Promise<SessionHistoryEntryDto[]> {
  const searchParams = new URLSearchParams();
  if (limit !== undefined) {
    searchParams.set('limit', String(limit));
  }
  if (projectId !== undefined) {
    searchParams.set('projects', projectId);
  }
  const query = searchParams.toString();
  const path =
    query.length > 0 ? `/api/sessions/history?${query}` : '/api/sessions/history';
  return fetchJson<SessionHistoryEntryDto[]>(path);
}

export function fetchSessionTail(
  sessionId: string,
  lines?: number,
): Promise<SessionTailDto> {
  const searchParams = new URLSearchParams();
  if (lines !== undefined) {
    searchParams.set('lines', String(lines));
  }
  const query = searchParams.toString();
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/tail${
    query.length > 0 ? `?${query}` : ''
  }`;
  return fetchJson<SessionTailDto>(path);
}

export function fetchAgentProcesses(): Promise<AgentProcessDto[]> {
  return fetchJson<AgentProcessDto[]>('/api/processes');
}

/** サーバーの実行プラットフォームで使えない機能 (bdboard-70z.9)。 */
export type PlatformFeature = 'session-discovery' | 'chat';

export interface PlatformLimitationDto {
  feature: PlatformFeature;
  /** UI にそのまま出す一文。 */
  reason: string;
  /** 「なぜ直せないのか」の技術的な根拠。 */
  detail: string;
}

export interface PlatformSupportDto {
  platform: string;
  limitations: PlatformLimitationDto[];
}

export function fetchPlatformSupport(): Promise<PlatformSupportDto> {
  return fetchJson<PlatformSupportDto>('/api/platform-support');
}

export function fetchBoard(params: {
  projectIds: string[];
  view: BoardMode;
  epicId?: string;
}): Promise<BoardViewDto> {
  const searchParams = new URLSearchParams();
  searchParams.set('view', params.view);
  if (params.projectIds.length > 0) {
    searchParams.set('projects', params.projectIds.join(','));
  }
  if (params.epicId !== undefined) {
    searchParams.set('epicId', params.epicId);
  }
  return fetchJson<BoardViewDto>(`/api/board?${searchParams.toString()}`);
}

export function fetchStatus(): Promise<StatusDto> {
  return fetchJson<StatusDto>('/api/status');
}

export function fetchTicket(id: string): Promise<TicketDetailDto> {
  return fetchJson<TicketDetailDto>(`/api/tickets/${encodeURIComponent(id)}`);
}

export function fetchTicketComments(ticketId: string): Promise<CommentDto[]> {
  return fetchJson<CommentDto[]>(
    `/api/comments/${encodeURIComponent(ticketId)}`,
  );
}

export function fetchPendingDecisions(): Promise<PendingDecisionDto[]> {
  return fetchJson<PendingDecisionDto[]>('/api/tickets/pending-decisions');
}

export interface PrBadgeDto {
  ticketId: string;
  projectId: string;
  url: string;
  state: string | null;
  checkStatus: string | null;
}

export function fetchPrLinks(
  projectIds: readonly string[] = [],
): Promise<PrBadgeDto[]> {
  const searchParams = new URLSearchParams();
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  const query = searchParams.toString();
  const path = query.length > 0 ? `/api/pr-links?${query}` : '/api/pr-links';
  return fetchJson<PrBadgeDto[]>(path);
}

// 応答が読めなかったときの既定は 'unknown'。'ticket' に倒すと UI が
// 「確認待ちから外れ、次の更新で通常のレーンに戻ります」と、クライアントには
// 裏付けられない状態を断言してしまう。サーバー側の respond() が判定不能を
// close も label 剥がしもせず 'unknown' で返すのと同じ fail-safe を、
// 応答が壊れている場合にも通す (bdboard-bh48 レビュー指摘)。
function mapTicketDecisionOutcome(raw: unknown): TicketDecisionOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'unknown', closed: false };
  }
  const outcome = (raw as { outcome?: unknown }).outcome;
  if (typeof outcome !== 'object' || outcome === null) {
    return { kind: 'unknown', closed: false };
  }
  const kind = (outcome as { kind?: unknown }).kind;
  const closed = (outcome as { closed?: unknown }).closed;
  return {
    kind: kind === 'gate' ? 'gate' : kind === 'ticket' ? 'ticket' : 'unknown',
    closed: closed === true,
  };
}

export function postTicketDecision(
  id: string,
  body: { choice?: string; freeform?: string },
): Promise<TicketDecisionOutcome> {
  return fetchJson<{ ok: true; outcome?: { kind?: string; closed?: boolean } }>(
    `/api/tickets/${encodeURIComponent(id)}/decision`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  ).then((data) => mapTicketDecisionOutcome(data));
}

export type QuickActionRequest =
  | { action: 'claim' }
  | { action: 'close'; reason?: string }
  | { action: 'defer'; untilDate: string }
  | { action: 'undefer' }
  | { action: 'priority'; priority: number };

export function postTicketQuickAction(
  id: string,
  body: QuickActionRequest,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/quick-action`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  ).then(() => undefined);
}

// クイックアクションの Undo(逆操作)。claim/close/defer は逆操作の形が一意
// (unclaim/reopen/undefer 相当)なので追加の入力は不要。priority だけは実行前の値を
// 呼び出し元(フロント)が保持して渡す必要がある。expectedCurrentPriority はクイック
// アクション実行直後にセットした値で、サーバー側が Undo 実行時点の実際の優先度と比較する
// CAS チェックに使う(bdboard-3tw.82)。一致しない場合はサーバーが 409 を返し、上書きしない。
export type QuickActionUndoRequest =
  | { action: 'claim' }
  | { action: 'close' }
  | { action: 'defer' }
  | { action: 'undefer'; untilDate: string }
  | {
      action: 'priority';
      previousPriority: number;
      expectedCurrentPriority: number;
    };

export function postTicketQuickActionUndo(
  id: string,
  body: QuickActionUndoRequest,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/quick-action/undo`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  ).then(() => undefined);
}

export function postTicketComment(id: string, text: string): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/comment`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    },
  ).then(() => undefined);
}

export function postTicketDependency(
  id: string,
  dependsOnId: string,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/dependencies`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dependsOnId }),
    },
  ).then(() => undefined);
}

export function deleteTicketDependency(
  id: string,
  dependsOnId: string,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/dependencies/${encodeURIComponent(dependsOnId)}`,
    {
      method: 'DELETE',
    },
  ).then(() => undefined);
}

export function postTicketAddLabel(id: string, label: string): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/labels`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    },
  ).then(() => undefined);
}

export function deleteTicketLabel(id: string, label: string): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/labels/${encodeURIComponent(label)}`,
    {
      method: 'DELETE',
    },
  ).then(() => undefined);
}

export function patchTicketTitle(
  id: string,
  title: string,
  expectedCurrentTitle: string,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/title`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, expectedCurrentTitle }),
    },
  ).then(() => undefined);
}

export function patchTicketDescription(
  id: string,
  description: string,
  expectedCurrentDescription: string,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/description`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, expectedCurrentDescription }),
    },
  ).then(() => undefined);
}

export function postTicketSessionLink(
  id: string,
  sessionId: string,
): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/session-link`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    },
  ).then(() => undefined);
}

export function deleteTicketSessionLink(id: string): Promise<void> {
  return fetchJson<{ ok: true }>(
    `/api/tickets/${encodeURIComponent(id)}/session-link`,
    {
      method: 'DELETE',
    },
  ).then(() => undefined);
}

export function searchTickets(
  query: string,
  limit = 30,
): Promise<TicketSearchResultDto[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('q', query);
  searchParams.set('limit', String(limit));
  return fetchJson<TicketSearchResultDto[]>(`/api/search?${searchParams.toString()}`);
}

export function fetchActivity(
  days = 1,
  limit = 100,
  projectIds: readonly string[] = [],
): Promise<ActivityEventDto[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('days', String(days));
  searchParams.set('limit', String(limit));
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  return fetchJson<ActivityEventDto[]>(`/api/activity?${searchParams.toString()}`);
}

export function fetchTicketTimeline(
  ticketId: string,
  limit = 200,
): Promise<ActivityEventDto[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('limit', String(limit));
  return fetchJson<ActivityEventDto[]>(
    `/api/tickets/${encodeURIComponent(ticketId)}/timeline?${searchParams.toString()}`,
  );
}

export function fetchSimilarTickets(
  ticketId: string,
  limit = 5,
): Promise<TicketSimilarResultDto[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('limit', String(limit));
  return fetchJson<TicketSimilarResultDto[]>(
    `/api/tickets/${encodeURIComponent(ticketId)}/similar?${searchParams.toString()}`,
  );
}

export function fetchTicketInFlightOverlaps(
  ticketId: string,
): Promise<TicketInFlightOverlapDto[]> {
  return fetchJson<TicketInFlightOverlapDto[]>(
    `/api/tickets/${encodeURIComponent(ticketId)}/in-flight-overlaps`,
  );
}

export function fetchThroughputStats(
  weeks = 8,
  projectIds: readonly string[] = [],
): Promise<ThroughputStatsDto> {
  const searchParams = new URLSearchParams();
  searchParams.set('weeks', String(weeks));
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  return fetchJson<ThroughputStatsDto>(`/api/stats?${searchParams.toString()}`);
}

export function fetchModelStats(
  weeks = 8,
  projectIds: readonly string[] = [],
): Promise<ModelStatsDto> {
  const searchParams = new URLSearchParams();
  searchParams.set('weeks', String(weeks));
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  return fetchJson<ModelStatsDto>(`/api/model-stats?${searchParams.toString()}`);
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

export function fetchCfdStats(
  days = 30,
  projectIds: readonly string[] = [],
): Promise<CfdStatsDto> {
  const searchParams = new URLSearchParams();
  searchParams.set('days', String(days));
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  return fetchJson<CfdStatsDto>(`/api/cfd?${searchParams.toString()}`);
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

export interface GraphNodeDto {
  ticketId: string;
  projectId: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  layer: number;
}

export interface GraphEdgeDto {
  from: string;
  to: string;
  kind: 'blocks' | 'parent-child';
}

export interface DependencyGraphDto {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
}

export function fetchDependencyGraph(
  projectIds: readonly string[] = [],
): Promise<DependencyGraphDto> {
  const searchParams = new URLSearchParams();
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  const query = searchParams.toString();
  const path = query.length > 0 ? `/api/graph?${query}` : '/api/graph';
  return fetchJson<DependencyGraphDto>(path);
}

export function isLaneStatusMismatch(lane: string, status: string): boolean {
  const expected = LANE_EXPECTED_STATUS[lane as Lane];
  if (expected === undefined) {
    return false;
  }
  return !expected.includes(status);
}

export function projectNameFallback(projectId: string): string {
  const parts = projectId.split(/[/\\]/);
  return parts[parts.length - 1] || projectId;
}

export type TunnelStateKind =
  | 'off'
  | 'starting'
  | 'on'
  | 'error'
  | 'unavailable';

export interface TunnelDtoBase {
  state: TunnelStateKind;
  available: boolean;
  /** Site-wide Basic Auth is active, so starting a public tunnel is safe. */
  authEnabled: boolean;
  /** 前回サーバー停止時にトンネルが稼働していた場合の停止時刻 (bdboard-8v8)。
   *  サーバーは state==='on' のときは返さない。資格情報は含まれない。 */
  interruptedAt?: string;
}

export interface TunnelDtoOn extends TunnelDtoBase {
  state: 'on';
  url: string;
  startedAt: string;
  /** トンネル経由の書き込みが開いているか(bdboard-9rz)。短いパスワードで起動した
   *  トンネルは読み取り専用になるので、UI 側で理由を説明するのに使える。 */
  writeAccess?: boolean;
}

export interface TunnelDtoError extends TunnelDtoBase {
  state: 'error';
  message: string;
}

export type TunnelDto =
  | (TunnelDtoBase & { state: 'off' })
  | (TunnelDtoBase & { state: 'starting' })
  | TunnelDtoOn
  | TunnelDtoError
  | (TunnelDtoBase & { state: 'unavailable' });

export function fetchTunnel(): Promise<TunnelDto> {
  return fetchJson<TunnelDto>('/api/tunnel');
}

export function startTunnel(password?: string): Promise<TunnelDto> {
  const body =
    password !== undefined && password.length > 0 ? { password } : {};
  return fetchJson<TunnelDto>('/api/tunnel/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function stopTunnel(): Promise<TunnelDto> {
  return fetchJson<TunnelDto>('/api/tunnel/stop', {
    method: 'POST',
  });
}

export function dismissTunnelInterruption(): Promise<TunnelDto> {
  return fetchJson<TunnelDto>('/api/tunnel/interruption/dismiss', {
    method: 'POST',
  });
}

export interface TunnelAccessTokenDto {
  token: string;
  expiresAt: string;
}

export function createTunnelAccessToken(): Promise<TunnelAccessTokenDto> {
  return fetchJson<TunnelAccessTokenDto>('/api/tunnel/access-token', {
    method: 'POST',
  });
}

/** src/application/ports/chat-agent.ts の ChatAgentAvailability と同形の二重定義。 */
export type ChatAgentAvailability = 'available' | 'unknown' | 'unavailable';

export interface ChatAvailabilityDto {
  availability: ChatAgentAvailability;
}

/**
 * src/interface/http/dto.ts の ChatAgentDto と同形の二重定義。
 * web から src への import は依存境界で禁止されているので、意図的に重複させている。
 */
export type ChatAgentCapability = 'bd-only' | 'reads-project' | 'unrestricted';

export interface ChatModelDto {
  id: string;
  label: string;
}

export interface ChatAgentDto {
  id: string;
  label: string;
  model?: string;
  models?: ChatModelDto[];
  experimental: boolean;
  capability: ChatAgentCapability;
  availability: ChatAgentAvailability;
  supportsStreaming: boolean;
  supportsImages: boolean;
}

export type ChatImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ChatImagePayload {
  mimeType: ChatImageMimeType;
  /** data URL prefix を含まない base64 本体。 */
  data: string;
}

export interface ChatMessageRequest {
  projectId: string;
  message: string;
  sessionId?: string;
  agentId?: string;
  model?: string;
  images?: ChatImagePayload[];
}

export interface ChatMessageResponseDto {
  reply: string;
  sessionId: string;
  agentId: string;
  model?: string;
  /** 今回のターンで実行できなかった bd ツール呼び出しの名前。無ければ省略される。 */
  failedTools?: string[];
  /** ターンは成功したが運用者に知らせるべきエージェント側の警告。無ければ省略される。 */
  agentWarnings?: string[];
}

export interface ChatSessionMessageDto {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  failedTools?: string[];
  agentWarnings?: string[];
}

export interface ChatSessionMessagesDto {
  sessionId: string;
  agentId: string;
  model?: string;
  messages: ChatSessionMessageDto[];
}

export interface ChatThreadDto {
  sessionId: string;
  agentId: string;
  title: string | null;
  pinned: boolean;
  updatedAt: string;
}

export type ChatTurnStatusDto =
  | { state: 'idle' }
  | {
      state: 'processing';
      sessionId?: string;
      agentId?: string;
      message?: string;
    }
  | {
      state: 'completed';
      sessionId: string;
      agentId: string;
      completedAt: string;
    };

export interface DiscoveredChatSessionDto {
  sessionId: string;
  lastActivityAt: string;
  alreadyAdopted: boolean;
  firstMessagePreview?: string;
  lastMessagePreview?: string;
}

export interface DiscoveredChatSessionsDto {
  sessions: DiscoveredChatSessionDto[];
}

export interface AdoptChatSessionResponseDto {
  sessionId: string;
  agentId: string;
  /**
   * adopt 直後にチャット履歴をシードするための、トランスクリプト末尾の会話
   * (bdboard-3tw.104.3 レビュー M1)。discovery が local-only ガード配下で既に読んだ
   * トランスクリプトから返るので、別途 `/api/sessions/:id/tail` を叩き直す必要はない。
   */
  seedMessages: SessionTailMessageDto[];
}

export function fetchChatAvailability(): Promise<ChatAvailabilityDto> {
  return fetchJson<ChatAvailabilityDto>('/api/chat/availability');
}

export function fetchChatAgents(): Promise<ChatAgentDto[]> {
  return fetchJson<ChatAgentDto[]>('/api/chat/agents');
}

export function fetchChatThreads(projectId: string): Promise<ChatThreadDto[]> {
  const params = new URLSearchParams({ projectId });
  return fetchJson<ChatThreadDto[]>(`/api/chat/threads?${params.toString()}`);
}

export function fetchChatTurnStatus(projectId: string): Promise<ChatTurnStatusDto> {
  const params = new URLSearchParams({ projectId });
  return fetchJson<ChatTurnStatusDto>(
    `/api/chat/turn-status?${params.toString()}`,
  );
}

export function acknowledgeChatTurn(projectId: string, sessionId: string): Promise<void> {
  const params = new URLSearchParams({ projectId, sessionId });
  return fetchJson<void>(`/api/chat/turn-status?${params.toString()}`, {
    method: 'DELETE',
  });
}

export function deleteChatThread(sessionId: string, projectId: string): Promise<void> {
  const params = new URLSearchParams({ projectId });
  return fetchJson<void>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`,
    { method: 'DELETE' },
  );
}

export function updateChatThread(
  sessionId: string,
  projectId: string,
  patch: { title?: string | null; pinned?: boolean },
): Promise<ChatThreadDto> {
  return fetchJson<ChatThreadDto>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/thread`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, ...patch }),
    },
  );
}

export function postChatMessage(
  body: ChatMessageRequest,
  signal?: AbortSignal,
): Promise<ChatMessageResponseDto> {
  const payload: ChatMessageRequest = {
    projectId: body.projectId,
    message: body.message,
  };
  if (body.sessionId !== undefined) {
    payload.sessionId = body.sessionId;
  }
  if (body.agentId !== undefined) {
    payload.agentId = body.agentId;
  }
  if (body.model !== undefined) {
    payload.model = body.model;
  }
  if (body.images !== undefined) {
    payload.images = body.images;
  }
  return fetchJson<ChatMessageResponseDto>('/api/chat/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...(signal !== undefined ? { signal } : {}),
  });
}

export function postChatMessageStream(
  body: ChatMessageRequest,
  callbacks: { onDelta: (text: string) => void },
  signal?: AbortSignal,
): Promise<ChatMessageResponseDto> {
  const payload: typeof body = { projectId: body.projectId, message: body.message };
  if (body.sessionId !== undefined) payload.sessionId = body.sessionId;
  if (body.agentId !== undefined) payload.agentId = body.agentId;
  if (body.model !== undefined) payload.model = body.model;
  if (body.images !== undefined) payload.images = body.images;

  return (async () => {
    const res = await fetch('/api/chat/message/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) {
      const { body: errorBody, errorMessage, detail, code, details } = await readErrorPayload(res);
      throw new ApiError(
        res.status,
        errorMessage ?? `HTTP ${res.status} ${res.statusText}: /api/chat/message/stream`,
        { body: errorBody, errorMessage, detail, code, details },
      );
    }
    if (res.body === null) throw new Error('no response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: ChatMessageResponseDto | undefined;
    const processEvent = (eventBlock: string) => {
      let eventName: string | undefined;
      // bdboard-l1t.9 Opus レビュー N4: SSE の仕様上、1イベントに複数の `data:` 行が
      // あれば改行で連結するのが正しい(上書きではない)。このサーバー実装は
      // 常に1行しか出さないが、仕様通りに実装しておく。
      const dataLines: string[] = [];
      for (const line of eventBlock.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join('\n');
      if (eventName === 'delta') {
        callbacks.onDelta((JSON.parse(data) as { text: string }).text);
      } else if (eventName === 'done') {
        result = JSON.parse(data) as ChatMessageResponseDto;
      } else if (eventName === 'error') {
        const parsed = JSON.parse(data) as { error: string; code?: string; detail?: string };
        throw new ApiError(502, parsed.error, {
          errorMessage: parsed.error,
          code: parsed.code,
          detail: parsed.detail,
        });
      }
    };

    try {
      while (result === undefined) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events) {
          processEvent(event);
          if (result !== undefined) break;
        }
      }
    } finally {
      // bdboard-l1t.9 Opus レビュー S4: error throw 時・done 到達後の break 時に
      // reader を握ったままにしない。reader.cancel() はサーバー側の
      // c.req.raw.signal 'abort' にも波及し、まだ動いている子プロセスの
      // 停止にもつながる副次効果がある。
      reader.cancel().catch(() => {});
    }
    if (result === undefined) throw new Error('chat stream ended unexpectedly');
    return result;
  })();
}

export function fetchChatSessionMessages(
  sessionId: string,
  projectId: string,
): Promise<ChatSessionMessagesDto> {
  const params = new URLSearchParams({ projectId });
  return fetchJson<ChatSessionMessagesDto>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`,
  );
}

export function fetchDiscoveredChatSessions(
  projectId: string,
): Promise<DiscoveredChatSessionsDto> {
  return fetchJson<DiscoveredChatSessionsDto>(
    `/api/chat/projects/${encodeURIComponent(projectId)}/discovered-sessions`,
  );
}

export function adoptDiscoveredChatSession(
  projectId: string,
  sessionId: string,
  agentId?: string,
): Promise<AdoptChatSessionResponseDto> {
  return fetchJson<AdoptChatSessionResponseDto>(
    `/api/chat/projects/${encodeURIComponent(projectId)}/discovered-sessions/${encodeURIComponent(sessionId)}/adopt`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(agentId !== undefined ? { agentId } : {}),
    },
  );
}

export interface AiQuotaMetricDto {
  label: string;
  percentRemaining?: number;
  resetInText?: string;
  resetAt?: string;
  status?: 'available' | 'exhausted';
  valueText?: string;
}

export interface AiQuotaProviderDto {
  id: string;
  label: string;
  vendor?: string;
  plan?: string;
  availability: 'live' | 'manual' | 'unavailable';
  detail?: string;
  metrics: AiQuotaMetricDto[];
}

export type AiQuotaDto =
  | { state: 'ok'; fetchedAt: string; providers: AiQuotaProviderDto[] }
  | { state: 'error'; message: string };

export function fetchAiQuota(): Promise<AiQuotaDto> {
  return fetchJson<AiQuotaDto>('/api/ai-quota');
}

/** 新しいリリースの有無 (bdboard-70z.7)。`unknown` は「確認できなかった」で、
 *  無効化されている場合もこれになる。UI 側は黙る。 */
export type UpdateCheckDto =
  | { state: 'up-to-date'; currentVersion: string }
  | { state: 'unknown'; currentVersion: string }
  | {
      state: 'update-available';
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
    };

export function fetchUpdateCheck(): Promise<UpdateCheckDto> {
  return fetchJson<UpdateCheckDto>('/api/update-check');
}

export interface HarnessPackSummaryDto {
  name: string;
  version: string;
  description: string;
}

/**
 * `.claude/settings.json` への hook 登録状況。`none-declared` は「そのパックが
 * hook を宣言していない」で、警告の対象外 (bdboard-pkr6.2)。
 */
export type HarnessHooksStateDto = 'ok' | 'missing' | 'partial' | 'none-declared';

export interface ProjectHarnessPackStatusDto {
  name: string;
  availableVersion: string;
  installedVersion: string | null;
  drift: boolean;
  hooksState: HarnessHooksStateDto;
  missingHooks: string[];
}

export type HarnessPrFlowDto = 'pr' | 'direct' | 'none';

/**
 * 注入先プロジェクトの検証コントラクト (`.claude/bdboard-harness.json`) の状態。
 * `not-applicable` はパック未注入のプロジェクト — UI には何も出さない。
 */
export type ProjectHarnessContractDto =
  | {
      state: 'ok';
      verify: string;
      prFlow: HarnessPrFlowDto;
      mainBranch: string;
    }
  | { state: 'missing' }
  | { state: 'invalid'; message: string }
  | { state: 'command-missing'; script: string; verify: string }
  | { state: 'not-applicable' };

export interface ProjectHarnessStatusDto {
  packs: ProjectHarnessPackStatusDto[];
  contract: ProjectHarnessContractDto;
}

export interface ProjectHarnessStatusEntryDto {
  projectId: string;
  packs: ProjectHarnessPackStatusDto[];
  contract: ProjectHarnessContractDto;
}

export interface AllHarnessStatusDto {
  projects: ProjectHarnessStatusEntryDto[];
}

export function fetchHarnessPacks(): Promise<HarnessPackSummaryDto[]> {
  return fetchJson<HarnessPackSummaryDto[]>('/api/harness/packs');
}

export function fetchAllHarnessStatus(): Promise<AllHarnessStatusDto> {
  return fetchJson<AllHarnessStatusDto>('/api/harness/status');
}

export function fetchProjectHarnessStatus(
  projectId: string,
): Promise<ProjectHarnessStatusDto> {
  return fetchJson<ProjectHarnessStatusDto>(
    `/api/projects/${encodeURIComponent(projectId)}/harness`,
  );
}

export function postProjectHarnessInject(
  projectId: string,
  pack: string,
): Promise<ProjectHarnessStatusDto> {
  return fetchJson<ProjectHarnessStatusDto>(
    `/api/projects/${encodeURIComponent(projectId)}/harness/inject`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack }),
    },
  );
}
