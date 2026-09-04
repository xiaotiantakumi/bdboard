import type { Board, BoardCard } from '../../domain/board.js';
import {
  computeLiveness,
  type Liveness,
  type LivenessThresholds,
} from '../../domain/liveness.js';
import type { Project } from '../../domain/project.js';
import { LANES } from '../../domain/readiness.js';
import type { AgentSession } from '../../domain/session.js';
import type { IssueComment } from '../../domain/issue-comment.js';
import type { Ticket } from '../../domain/ticket.js';
import type { ActivityEvent } from '../../application/board/get-activity-feed.js';
import type {
  AgeDistribution,
  ProjectThroughputStats,
  ThroughputStats,
  WeeklyCloseCount,
} from '../../application/board/get-throughput-stats.js';
import type { CfdDayEntry, CfdStats, ProjectCfdStats } from '../../application/board/get-cfd-stats.js';
import type {
  ModelStats,
  StageModelCounts,
  WeeklyModelCloseCounts,
} from '../../application/board/get-model-stats.js';
import type { HarnessKpiStats } from '../../application/board/get-harness-kpi.js';
import type { HygieneIssue } from '../../domain/hygiene.js';
import type { StaleLeaseIssue } from '../../domain/lease.js';
import type { MergeSlotStatus } from '../../domain/merge-slot.js';
import type { PrBadge } from '../../domain/pr-link.js';
import type {
  ReclaimSchedulerStatus,
  ReclaimProjectStatus,
} from '../../application/lease/reclaim-scheduler.js';
import type { DependencyGraph } from '../../domain/dependency-graph.js';
import type { BoardView } from '../../application/board/get-board.js';
import type { TicketSearchHit } from '../../application/board/search-tickets.js';
import type { SimilarTicketHit } from '../../application/board/find-similar-tickets.js';
import type { TicketTokenUsage } from '../../application/board/get-ticket-token-usage.js';
import type {
  SessionHistoryEntry,
  SessionHistoryTicketRef,
} from '../../application/session/get-session-history.js';
import type { TranscriptTailMessage } from '../../application/transcript/parse-transcript-messages.js';
import type { ListedAgentProcess } from '../../application/session/list-agent-processes.js';
import type {
  ChatAgentAvailability,
  ChatAgentCapability,
  ChatAgentDescriptor,
} from '../../application/ports/chat-agent.js';

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

export interface TicketChildDto {
  id: string;
  title: string;
  lane: string;
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

export interface DiscoveredChatSessionDto {
  sessionId: string;
  lastActivityAt: string;
  alreadyAdopted: boolean;
  firstMessagePreview?: string;
  lastMessagePreview?: string;
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
  deferUrgency: string | null;
  effectivePriority: number;
  priorityInheritedFrom: string | null;
}

export interface BoardDto {
  lanes: Record<string, BoardCardDto[]>;
  cardCount: number;
  /**
   * done(closed) レーンの切り捨て前の総件数。closedLimit が効いて
   * lanes.done.length より大きいときは「他 N 件(非表示)」の算出に使う
   * (bdboard-3tw.86)。
   */
  closedTotal: number;
  /**
   * closedLimit で切り捨てられ、lanes.done には出てこないチケットのID一覧
   * (カード全体ではなくIDのみ)。bdboard-3tw.64 の既知ID自動リンク判定
   * (web/src/App.tsx の boardTicketIds)がこれも「ボード上に存在する」扱いにできるよう
   * 送る(bdboard-3tw.86 回帰対応: 古い closed チケットへの相互参照リンクが
   * closedLimit の切り捨てで失われていた)。
   */
  truncatedClosedIds: string[];
}

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
  /** 確認待ちのまま close されたチケット数 (期間内) */
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
  /**
   * この統計が「いつ以降」のものか (= サーバー起動時刻、バッファが溢れた後は
   * 残っている最古の実行時刻)。永続化していないので UI に注記する
   */
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
  | 'missing_priority'
  | 'unblocked_high_priority_idle'
  | 'stale_pending_decision'
  | 'merged_leftover';

export interface HygieneCycleEdgeDto {
  issueId: string;
  dependsOnId: string;
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
  deferUntil?: string;
  cycleTicketIds?: string[];
  cycleEdges?: HygieneCycleEdgeDto[];
}

export interface StaleLeaseDto {
  ticketId: string;
  projectId: string;
  leaseExpiresAt: string;
  staleForMs: number;
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

export interface PrBadgeDto {
  ticketId: string;
  projectId: string;
  url: string;
  state: string | null;
  checkStatus: string | null;
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

export function toTicketSummaryDto(ticket: Ticket): TicketSummaryDto {
  return {
    id: ticket.id,
    projectId: ticket.projectId,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    issueType: ticket.issueType,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    ...(ticket.startedAt !== undefined
      ? { startedAt: ticket.startedAt.toISOString() }
      : {}),
    ...(ticket.closedAt !== undefined
      ? { closedAt: ticket.closedAt.toISOString() }
      : {}),
    ...(ticket.deferUntil !== undefined
      ? { deferUntil: ticket.deferUntil.toISOString() }
      : {}),
    ...(ticket.assignee !== undefined ? { assignee: ticket.assignee } : {}),
    ...(ticket.owner !== undefined ? { owner: ticket.owner } : {}),
    ...(ticket.parentId !== undefined ? { parentId: ticket.parentId } : {}),
    commentCount: ticket.commentCount,
    ...(ticket.labels !== undefined ? { labels: [...ticket.labels] } : {}),
  };
}

/*
 * liveness を出す DTO 変換はすべて、解決済みの閾値 (ユーザー設定の上書きを
 * 含む) を **必須の第3引数** で受け取る (bdboard-3tw.102.5 → bdboard-5kz2)。
 *
 * 当初は任意引数にして「省略時は computeLiveness のデフォルト」に落としていたが、
 * それだと渡し忘れが型でも全テストでも検出できなかった。実際 bdboard-3tw.102.5 の
 * 初版では、toBoardCardDto / toBoardDto / toBoardViewDto のどこで引数を落としても
 * サーバー全2327テストが通ってしまう状態だった (渡し忘れの症状は「古い閾値のまま
 * 表示される」で、例外にならないぶん気づけない)。必須にして tsc で落とす。
 *
 * 既定値でよい呼び出し元は DEFAULT_LIVENESS_THRESHOLDS を明示的に渡すこと。
 * 「既定でよい」と「渡し忘れた」を、読んで区別できるようにするのが狙い。
 */
export function toSessionDto(
  session: AgentSession,
  now: Date,
  livenessThresholds: LivenessThresholds,
): SessionDto {
  return {
    sessionId: session.sessionId,
    pid: session.pid,
    cwd: session.cwd,
    alive: session.alive,
    startedAt: session.startedAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    liveness: computeLiveness(now, session, livenessThresholds),
    ...(session.name !== undefined ? { name: session.name } : {}),
  };
}

function toSessionHistoryTicketDto(
  ticket: SessionHistoryTicketRef,
): SessionHistoryTicketDto {
  return {
    ticketId: ticket.ticketId,
    ...(ticket.title !== undefined ? { title: ticket.title } : {}),
  };
}

export function toSessionTailMessageDto(
  message: TranscriptTailMessage,
): SessionTailMessageDto {
  return {
    role: message.role,
    text: message.text,
    ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
  };
}

/*
 * 注意: ここで渡した閾値は結果に影響しない。getSessionHistory が返すのは
 * alive === false のセッションだけで、computeLiveness は !alive を閾値より先に
 * 見て dormant を返すため。「ended だけ」という条件が将来外れたときに配線漏れを
 * 作らないよう、引数は他と同じ形で受け取っている (bdboard-3tw.102.5)。
 */
export function toSessionHistoryEntryDto(
  entry: SessionHistoryEntry,
  now: Date,
  livenessThresholds: LivenessThresholds,
): SessionHistoryEntryDto {
  return {
    session: toSessionDto(entry.session, now, livenessThresholds),
    ...(entry.project !== undefined
      ? {
          projectId: entry.project.id,
          projectName: entry.project.name,
        }
      : {}),
    tickets: entry.tickets.map(toSessionHistoryTicketDto),
  };
}

export function toBoardCardDto(
  card: BoardCard,
  now: Date,
  livenessThresholds: LivenessThresholds,
): BoardCardDto {
  return {
    ticket: toTicketSummaryDto(card.ticket),
    lane: card.lane,
    projectId: card.projectId,
    blockedBy: [...card.blockedBy],
    blocks: [...card.blocks],
    unblocksCount: card.unblocksCount,
    liveness: card.liveness,
    sessions: card.sessions.map((session) =>
      toSessionDto(session, now, livenessThresholds),
    ),
    stalled: card.stalled,
    epicProgress:
      card.epicProgress === null
        ? null
        : { total: card.epicProgress.total, done: card.epicProgress.done },
    deferDays: card.deferDays,
    deferUrgency: card.deferUrgency,
    effectivePriority: card.effectivePriority,
    priorityInheritedFrom: card.priorityInheritedFrom,
  };
}

export interface ToBoardDtoOptions {
  readonly closedTotal?: number;
  readonly truncatedClosedIds?: readonly string[];
}

export function toBoardDto(
  board: Board,
  now: Date,
  livenessThresholds: LivenessThresholds,
  options?: ToBoardDtoOptions,
): BoardDto {
  const closedTotal = options?.closedTotal;
  const truncatedClosedIds = options?.truncatedClosedIds;
  const lanes: Record<string, BoardCardDto[]> = {};
  for (const lane of LANES) {
    lanes[lane] = board.lanes[lane].map((card) =>
      toBoardCardDto(card, now, livenessThresholds),
    );
  }

  return {
    lanes,
    cardCount: board.cards.length,
    closedTotal: closedTotal ?? board.lanes.done.length,
    truncatedClosedIds: truncatedClosedIds !== undefined ? [...truncatedClosedIds] : [],
  };
}

export function countIncompleteTicketsFromTickets(
  tickets: readonly Ticket[],
): number {
  return tickets.filter((ticket) => ticket.status !== 'closed').length;
}

export function countIncompleteTicketsFromBoard(board: Board): number {
  return (
    board.lanes.ready.length +
    board.lanes.in_progress.length +
    board.lanes.awaiting_human.length +
    board.lanes.blocked.length
  );
}

export interface ToProjectDtoOptions {
  readonly sessions?: readonly AgentSession[];
  readonly incompleteTicketCount?: number;
}

export function toProjectDto(
  project: Project,
  now: Date,
  livenessThresholds: LivenessThresholds,
  options?: ToProjectDtoOptions,
): ProjectDto {
  const sessions = options?.sessions;
  const incompleteTicketCount = options?.incompleteTicketCount ?? 0;
  const sessionDtos =
    sessions !== undefined
      ? sessions.map((session) => toSessionDto(session, now, livenessThresholds))
      : [];

  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    prefixes: [...project.prefixes],
    sessionCount: sessions !== undefined ? sessions.length : 0,
    activeSessionCount:
      sessions !== undefined
        ? sessions.filter(
            (s) => computeLiveness(now, s, livenessThresholds) === 'active',
          ).length
        : 0,
    incompleteTicketCount,
    sessions: sessionDtos,
  };
}

export function toBoardViewDto(
  view: BoardView,
  livenessThresholds: LivenessThresholds,
  sessionsByProject?: ReadonlyMap<string, readonly AgentSession[]>,
): BoardViewDto {
  const now = view.generatedAt;

  // mode==='merged' では merged が projects の全チケットを既に統合しているので、
  // projects 側もそのままシリアライズすると全チケットが2回送られる(bdboard-3tw.86)。
  // BoardView.projects 自体は application 層の内部表現として常に埋めたままにし
  // (/api/tickets/:id 等 view.merged を経由しない既存の内部利用に影響を与えないため)、
  // ワイヤーに出す直前のこの変換でだけ空にする。
  const projects =
    view.mode === 'merged'
      ? []
      : view.projects.map((projectBoard) => ({
          project: toProjectDto(projectBoard.project, now, livenessThresholds, {
            sessions: sessionsByProject?.get(projectBoard.project.id),
            incompleteTicketCount: countIncompleteTicketsFromBoard(
              projectBoard.board,
            ),
          }),
          board: toBoardDto(projectBoard.board, now, livenessThresholds, {
            closedTotal: projectBoard.closedTotal,
            truncatedClosedIds: projectBoard.truncatedClosedIds,
          }),
        }));

  return {
    mode: view.mode,
    generatedAt: view.generatedAt.toISOString(),
    projects,
    merged:
      view.merged !== null
        ? toBoardDto(view.merged, now, livenessThresholds, {
            closedTotal: view.mergedClosedTotal ?? undefined,
            truncatedClosedIds: view.mergedTruncatedClosedIds ?? undefined,
          })
        : null,
  };
}

export function toTicketDetailDto(
  card: BoardCard,
  sessionLinks: readonly TicketSessionLinkDto[] = [],
  models: readonly TicketModelDto[] = [],
  children: readonly TicketChildDto[] = [],
): TicketDetailDto {
  const summary = toTicketSummaryDto(card.ticket);

  return {
    ...summary,
    ...(card.ticket.description !== undefined
      ? { description: card.ticket.description }
      : {}),
    ...(card.ticket.notes !== undefined ? { notes: card.ticket.notes } : {}),
    dependencies: card.ticket.dependencies.map((edge) => ({
      issueId: edge.issueId,
      dependsOnId: edge.dependsOnId,
      kind: edge.kind,
    })),
    blockedBy: [...card.blockedBy],
    blocks: [...card.blocks],
    sessionLinks: [...sessionLinks],
    models: [...models],
    children: [...children],
  };
}

export function toTicketTokenUsageDto(usage: TicketTokenUsage): TicketTokenUsageDto {
  return {
    totalInputTokens: usage.totalInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalCacheCreationInputTokens: usage.totalCacheCreationInputTokens,
    totalCacheReadInputTokens: usage.totalCacheReadInputTokens,
    byModel: usage.byModel.map((entry) => ({
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheCreationInputTokens: entry.cacheCreationInputTokens,
      cacheReadInputTokens: entry.cacheReadInputTokens,
    })),
  };
}

export function toTicketSearchResultDto(hit: TicketSearchHit): TicketSearchResultDto {
  return {
    id: hit.ticket.id,
    projectId: hit.ticket.projectId,
    projectName: hit.project.name,
    title: hit.ticket.title,
    status: hit.ticket.status,
    priority: hit.ticket.priority,
    issueType: hit.ticket.issueType,
  };
}

export function toTicketSimilarResultDto(hit: SimilarTicketHit): TicketSimilarResultDto {
  return {
    id: hit.ticket.id,
    projectId: hit.ticket.projectId,
    projectName: hit.project.name,
    title: hit.ticket.title,
    status: hit.ticket.status,
    priority: hit.ticket.priority,
    issueType: hit.ticket.issueType,
    score: hit.score,
  };
}

export function toActivityEventDto(event: ActivityEvent): ActivityEventDto {
  return {
    kind: event.kind,
    at: event.at.toISOString(),
    id: event.ticket.id,
    projectId: event.ticket.projectId,
    projectName: event.project.name,
    title: event.ticket.title,
    status: event.ticket.status,
    priority: event.ticket.priority,
    issueType: event.ticket.issueType,
    ...(event.actor !== undefined ? { actor: event.actor } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.from !== undefined ? { from: event.from } : {}),
    ...(event.to !== undefined ? { to: event.to } : {}),
  };
}

function toWeeklyCloseCountDto(entry: WeeklyCloseCount): WeeklyCloseCountDto {
  return {
    weekStart: entry.weekStart.toISOString(),
    count: entry.count,
  };
}

function toAgeDistributionDto(distribution: AgeDistribution): AgeDistributionDto {
  return {
    d0to1: distribution.d0to1,
    d1to7: distribution.d1to7,
    d7to30: distribution.d7to30,
    d30plus: distribution.d30plus,
  };
}

function toProjectThroughputStatsDto(
  stats: ProjectThroughputStats,
): ProjectThroughputStatsDto {
  return {
    projectId: stats.project.id,
    projectName: stats.project.name,
    weeklyCloses: stats.weeklyCloses.map(toWeeklyCloseCountDto),
    openTicketAge: toAgeDistributionDto(stats.openTicketAge),
  };
}

export function toThroughputStatsDto(stats: ThroughputStats): ThroughputStatsDto {
  return {
    projects: stats.projects.map(toProjectThroughputStatsDto),
    totals: {
      weeklyCloses: stats.totals.weeklyCloses.map(toWeeklyCloseCountDto),
      openTicketAge: toAgeDistributionDto(stats.totals.openTicketAge),
    },
  };
}

function toWeeklyModelCloseCountsDto(
  entry: WeeklyModelCloseCounts,
): WeeklyModelCloseCountsDto {
  return {
    weekStart: entry.weekStart.toISOString(),
    counts: { ...entry.counts },
  };
}

function toStageModelCountsDto(entry: StageModelCounts): StageModelCountsDto {
  return {
    stage: entry.stage,
    counts: { ...entry.counts },
  };
}

export function toModelStatsDto(stats: ModelStats): ModelStatsDto {
  return {
    weeklyCloses: stats.weeklyCloses.map(toWeeklyModelCloseCountsDto),
    stageModelDistribution: stats.stageModelDistribution.map(toStageModelCountsDto),
  };
}

function toCfdDayEntryDto(entry: CfdDayEntry): CfdDayEntryDto {
  const counts: Record<string, number> = {};
  for (const [status, count] of Object.entries(entry.counts)) {
    if (count !== undefined) {
      counts[status] = count;
    }
  }
  return {
    date: entry.date,
    counts,
  };
}

function toProjectCfdStatsDto(stats: ProjectCfdStats): ProjectCfdStatsDto {
  return {
    projectId: stats.project.id,
    projectName: stats.project.name,
    days: stats.days.map(toCfdDayEntryDto),
  };
}

export function toCfdStatsDto(stats: CfdStats): CfdStatsDto {
  return {
    projects: stats.projects.map(toProjectCfdStatsDto),
    totals: stats.totals.map(toCfdDayEntryDto),
  };
}

export function toHarnessKpiDto(stats: HarnessKpiStats): HarnessKpiDto {
  const { kpi } = stats;
  return {
    rangeStart: kpi.rangeStart.toISOString(),
    rangeEnd: kpi.rangeEnd.toISOString(),
    pendingDecisionDwell: {
      closedCount: kpi.pendingDecisionDwell.closedCount,
      closedGateCount: kpi.pendingDecisionDwell.closedGateCount,
      closedWorkCount: kpi.pendingDecisionDwell.closedWorkCount,
      openCount: kpi.pendingDecisionDwell.openCount,
      openGateCount: kpi.pendingDecisionDwell.openGateCount,
      openWorkCount: kpi.pendingDecisionDwell.openWorkCount,
      medianMs: kpi.pendingDecisionDwell.medianMs,
      p90Ms: kpi.pendingDecisionDwell.p90Ms,
      anchor: kpi.pendingDecisionDwell.anchor,
    },
    reclaim: {
      runCount: kpi.reclaim.runCount,
      reclaimedCountTotal: kpi.reclaim.reclaimedCountTotal,
      unknownCountRunCount: kpi.reclaim.unknownCountRunCount,
      identifiedTicketCount: kpi.reclaim.identifiedTicketCount,
      reclaimedThenInProgressCount: kpi.reclaim.reclaimedThenInProgressCount,
      reclaimedThenInProgressRate: kpi.reclaim.reclaimedThenInProgressRate,
      windowMs: kpi.reclaim.windowMs,
      since: stats.reclaimSince?.toISOString() ?? null,
      unparsedRunCount: stats.reclaimUnparsedRunCount,
    },
    harnessLabeled: { ...kpi.harnessLabeled },
    duplicateMention: { ...kpi.duplicateMention },
  };
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
  };
}

export function toStaleLeaseDto(issue: StaleLeaseIssue): StaleLeaseDto {
  return {
    ticketId: issue.ticketId,
    projectId: issue.projectId,
    leaseExpiresAt: issue.leaseExpiresAt,
    staleForMs: issue.staleForMs,
  };
}

export function toMergeSlotStatusDto(status: MergeSlotStatus): MergeSlotStatusDto {
  return {
    projectId: status.projectId,
    present: status.present,
    held: status.held,
    holder: status.holder,
    heldSinceIso: status.heldSinceIso,
    heldForMs: status.heldForMs,
    isLongHeld: status.isLongHeld,
  };
}

export function toPrBadgeDto(badge: PrBadge): PrBadgeDto {
  return {
    ticketId: badge.ticketId,
    projectId: badge.projectId,
    url: badge.url,
    state: badge.status?.state ?? null,
    checkStatus: badge.status?.checkStatus ?? null,
  };
}

export function toReclaimProjectStatusDto(
  status: ReclaimProjectStatus,
): ReclaimProjectStatusDto {
  return {
    projectId: status.projectId,
    lastRunAt: status.lastRunAt,
    reclaimedCount: status.reclaimedCount,
    reclaimedCountUnknown: status.reclaimedCountUnknown,
    rawSummary: status.rawSummary,
    lastError: status.lastError,
  };
}

export function toReclaimSchedulerStatusDto(
  status: ReclaimSchedulerStatus,
): ReclaimSchedulerStatusDto {
  return {
    enabled: status.enabled,
    intervalMs: status.intervalMs,
    olderThan: status.olderThan,
    projects: status.projects.map(toReclaimProjectStatusDto),
  };
}

export function toLeaseHealthDto(input: {
  readonly staleLeases: readonly StaleLeaseIssue[];
  readonly reclaim: ReclaimSchedulerStatus;
}): LeaseHealthDto {
  return {
    staleLeases: input.staleLeases.map(toStaleLeaseDto),
    reclaim: toReclaimSchedulerStatusDto(input.reclaim),
  };
}

export function toDependencyGraphDto(graph: DependencyGraph): DependencyGraphDto {
  return {
    nodes: graph.nodes.map((node) => ({
      ticketId: node.ticketId,
      projectId: node.projectId,
      title: node.title,
      status: node.status,
      priority: node.priority,
      issueType: node.issueType,
      layer: node.layer,
    })),
    edges: graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
    })),
  };
}

export function toCommentDto(comment: IssueComment): CommentDto {
  return {
    id: comment.id,
    issueId: comment.issueId,
    author: comment.author,
    text: comment.text,
    createdAt: comment.createdAt.toISOString(),
  };
}

export function toAgentProcessDto(process: ListedAgentProcess): AgentProcessDto {
  return {
    pid: process.pid,
    command: process.command,
    cwd: process.cwd,
    ...(process.startedAt !== undefined
      ? { startedAt: process.startedAt.toISOString() }
      : {}),
    ...(process.projectId !== undefined ? { projectId: process.projectId } : {}),
    ...(process.projectName !== undefined
      ? { projectName: process.projectName }
      : {}),
  };
}

export interface ChatAgentDto {
  id: string;
  label: string;
  model?: string;
  models?: { id: string; label: string }[];
  experimental: boolean;
  supportsStreaming: boolean;
  supportsImages: boolean;
  capability: ChatAgentCapability;
  availability: ChatAgentAvailability;
}

export function toChatAgentDto(
  descriptor: ChatAgentDescriptor,
  availability: ChatAgentAvailability,
): ChatAgentDto {
  return {
    id: descriptor.id,
    label: descriptor.label,
    ...(descriptor.model !== undefined ? { model: descriptor.model } : {}),
    ...(descriptor.models !== undefined
      ? {
          models: descriptor.models.map((entry) => ({
            id: entry.id,
            label: entry.label,
          })),
        }
      : {}),
    experimental: descriptor.experimental,
    supportsStreaming: descriptor.supportsStreaming ?? false,
    supportsImages: descriptor.supportsImages ?? false,
    capability: descriptor.capability,
    availability,
  };
}
