import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { isSafeCliArgument } from '../../domain/chat.js';
import { getActivityFeed } from '../../application/board/get-activity-feed.js';
import { getTicketTimeline } from '../../application/board/get-ticket-timeline.js';
import { getSimilarTickets } from '../../application/board/find-similar-tickets.js';
import { getDependencyGraph } from '../../application/board/get-dependency-graph.js';
import { getHygieneIssues } from '../../application/board/get-hygiene-issues.js';
import { getPendingCommentAnchors } from '../../application/board/get-pending-comment-anchors.js';
import { getPrBadges, PrBadgeCommentCache } from '../../application/board/get-pr-badges.js';
import { getStaleLeaseIssues } from '../../application/board/get-stale-lease-issues.js';
import { getMergeSlotStatus } from '../../application/board/get-merge-slot-status.js';
import { scanGitLeftovers } from '../../application/board/scan-git-leftovers.js';
import type { LeftoverCandidate } from '../../domain/git-worktree.js';
import { getThroughputStats } from '../../application/board/get-throughput-stats.js';
import { getModelStats } from '../../application/board/get-model-stats.js';
import { getCfdStats } from '../../application/board/get-cfd-stats.js';
import { getBoardTimeZoneOverride } from '../../config/board-timezone.js';
import { getBoard } from '../../application/board/get-board.js';
import type { GetBoardDeps } from '../../application/board/get-board.js';
import {
  getTicketTokenUsage,
  hasTicketTokenUsage,
} from '../../application/board/get-ticket-token-usage.js';
import { searchTickets } from '../../application/board/search-tickets.js';
import type { ApplicationVersionProvider } from '../../application/ports/application-version.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import { BdError } from '../../application/ports/issue-repository.js';
import type { ProcessScanner } from '../../application/ports/process-scanner.js';
import type { HumanDecisionsPort } from '../../application/ports/human-decisions.js';
import type { WorktreeScanner } from '../../application/ports/worktree-scanner.js';
import type { DependencyWriterPort } from '../../application/ports/dependency-writer.js';
import {
  ContentConflictError,
  PriorityConflictError,
  StatusConflictError,
  type IssueWriterPort,
} from '../../application/ports/issue-writer.js';
import type { SessionLinkWriterPort } from '../../application/ports/session-link-writer.js';
import {
  DEFAULT_LIVENESS_THRESHOLDS,
  type LivenessThresholds,
} from '../../domain/liveness.js';
import type { ResolvedBoardThresholds } from '../../domain/board-thresholds.js';
import type { HygieneThresholds } from '../../domain/hygiene.js';
import type { Ticket } from '../../domain/ticket.js';
import { buildDirectChildrenIndex } from '../../domain/epic-progress.js';
import type { SessionTailReader } from '../../application/ports/session-tail-reader.js';
import type { LeaseReader } from '../../application/ports/lease-reader.js';
import type { MergeSlotReader } from '../../application/ports/merge-slot-reader.js';
import type { PrStatusReader } from '../../application/ports/pr-status-reader.js';
import type { ReclaimScheduler } from '../../application/lease/reclaim-scheduler.js';
import { getSessionHistory } from '../../application/session/get-session-history.js';
import { listAgentProcesses } from '../../application/session/list-agent-processes.js';
import {
  groupSessionsByProject,
  resolveSessionProject,
} from '../../application/session/link-sessions-to-projects.js';
import { compareStrings } from '../../domain/compare.js';
import type { AgentSession, SessionLink } from '../../domain/session.js';
import type { EventHub } from '../sse/event-hub.js';
import {
  countIncompleteTicketsFromTickets,
  toActivityEventDto,
  toAgentProcessDto,
  toBoardViewDto,
  toCommentDto,
  toProjectDto,
  toSessionDto,
  toSessionHistoryEntryDto,
  toSessionTailMessageDto,
  toDependencyGraphDto,
  toThroughputStatsDto,
  toModelStatsDto,
  toCfdStatsDto,
  toHygieneIssueDto,
  toLeaseHealthDto,
  toMergeSlotStatusDto,
  toPrBadgeDto,
  toTicketDetailDto,
  toTicketSearchResultDto,
  toTicketSimilarResultDto,
  toTicketTokenUsageDto,
  type ProjectDto,
  type TicketChildDto,
  type TicketSessionLinkDto,
} from './dto.js';
import {
  boardViewDtoStableJson,
  computeWeakEtag,
  ifNoneMatchMatches,
} from './etag.js';
import {
  createWriteGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';

export interface ApiStatus {
  readonly lastRefreshAt: Date | null;
  readonly errors: readonly { kind: string; projectId: string; detail: string }[];
  readonly projectCount: number;
}

export interface ApiDeps {
  readonly cache: BoardCache;
  readonly applicationVersion: ApplicationVersionProvider;
  readonly now: () => Date;
  readonly getStatus: () => ApiStatus;
  readonly refresh: () => Promise<void>;
  readonly events: EventHub;
  readonly sessions?: () => readonly AgentSession[];
  readonly links?: () => readonly SessionLink[];
  readonly commentReader?: CommentReader;
  readonly processScanner?: ProcessScanner;
  readonly humanDecisions?: HumanDecisionsPort;
  readonly worktreeScanner?: WorktreeScanner;
  readonly issueWriter?: IssueWriterPort;
  readonly dependencyWriter?: DependencyWriterPort;
  readonly sessionLinkWriter?: SessionLinkWriterPort;
  readonly sessionTail?: SessionTailReader;
  readonly leaseReader?: LeaseReader;
  readonly mergeSlotReader?: MergeSlotReader;
  readonly prStatusReader?: PrStatusReader;
  readonly reclaimScheduler?: ReclaimScheduler;
  /**
   * トンネル経由の書き込みを開放するための依存(bdboard-9rz)。
   * 省略された場合、書き込みは従来どおり localhost 直アクセス限定になる(fail-closed)。
   */
  readonly writeAccess?: WriteGuardDeps;
  readonly getBoardThresholds?: () => Promise<ResolvedBoardThresholds>;
  readonly getHygieneThresholds?: () => Promise<HygieneThresholds>;
}

interface QueuedSseMessage {
  readonly event?: string;
  readonly data: string;
}

const SEARCH_DEFAULT_LIMIT = 30;
const SEARCH_MIN_LIMIT = 1;
const SEARCH_MAX_LIMIT = 50;
const SIMILAR_DEFAULT_LIMIT = 5;
const SIMILAR_MIN_LIMIT = 1;
const SIMILAR_MAX_LIMIT = 20;

const ACTIVITY_DEFAULT_DAYS = 1;
const ACTIVITY_MIN_DAYS = 1;
const ACTIVITY_MAX_DAYS = 30;
const ACTIVITY_DEFAULT_LIMIT = 100;
const ACTIVITY_MIN_LIMIT = 1;
const ACTIVITY_MAX_LIMIT = 200;
const SESSION_HISTORY_DEFAULT_LIMIT = 50;
const SESSION_HISTORY_MIN_LIMIT = 1;
const SESSION_HISTORY_MAX_LIMIT = 200;
const SESSION_TAIL_DEFAULT_LIMIT = 50;
const SESSION_TAIL_MIN_LIMIT = 1;
const SESSION_TAIL_MAX_LIMIT = 200;

const STATS_DEFAULT_WEEKS = 8;
const STATS_MIN_WEEKS = 1;
const STATS_MAX_WEEKS = 26;

const CFD_DEFAULT_DAYS = 30;
const CFD_MIN_DAYS = 1;
const CFD_MAX_DAYS = 365;

// closed(done)レーンの既定上限。単調増加するdoneチケットが/api/boardペイロードを
// 支配しないよう、プロジェクトごとにclosedAt降順で上位N件だけを送る(bdboard-3tw.86)。
const BOARD_DEFAULT_CLOSED_LIMIT = 100;
const BOARD_MIN_CLOSED_LIMIT = 1;
const BOARD_MAX_CLOSED_LIMIT = 1000;

export interface PendingDecisionDto {
  readonly id: string;
  readonly projectId: string;
  readonly question?: string;
  readonly options?: readonly { readonly label: string; readonly value: string }[];
  readonly allowFreeform: boolean;
}

const decisionBodySchema = z.object({
  choice: z.string().min(1).optional(),
  freeform: z.string().min(1).optional(),
});

const commentBodySchema = z.object({
  text: z.string().min(1).max(2000),
});

const dependencyBodySchema = z.object({
  dependsOnId: z.string().min(1).max(200),
});

const updateTitleBodySchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .refine(isSafeCliArgument, { message: 'unsafe title' }),
  expectedCurrentTitle: z.string().max(200),
});

const updateDescriptionBodySchema = z.object({
  description: z.string().max(4000),
  expectedCurrentDescription: z.string().max(4000),
});

const sessionLinkBodySchema = z.object({
  sessionId: z.string().min(1).max(200),
});

const labelBodySchema = z.object({
  label: z
    .string()
    .min(1)
    .max(200)
    .refine(isSafeCliArgument, { message: 'unsafe label' }),
});

const quickActionBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim') }),
  z.object({
    action: z.literal('close'),
    reason: z.string().min(1).max(2000).optional(),
  }),
  z.object({ action: z.literal('defer'), untilDate: z.string() }),
  z.object({ action: z.literal('undefer') }),
  z.object({
    action: z.literal('priority'),
    priority: z.number().int().min(0).max(4),
  }),
]);

// クイックアクションの逆操作(undo)。claim/close/defer は逆操作の形が一意に決まるため
// (unclaim/reopen/undefer)追加の入力は不要。priority と undefer は「元の値へ戻す」という
// 操作の性質上、呼び出し元(フロント)がアクション実行前に保持していた値を渡す必要がある。
// expectedCurrentPriority は「クイックアクション実行直後にセットした値」で、CAS チェック
// (bdboard-3tw.82)に使う。previousPriority(戻し先)とは別物。
const quickActionUndoBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim') }),
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('defer') }),
  z.object({ action: z.literal('undefer'), untilDate: z.string().min(1) }),
  z.object({
    action: z.literal('priority'),
    previousPriority: z.number().int().min(0).max(4),
    expectedCurrentPriority: z.number().int().min(0).max(4),
  }),
]);

function parseSearchLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return SEARCH_DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return SEARCH_DEFAULT_LIMIT;
  }

  return Math.min(SEARCH_MAX_LIMIT, Math.max(SEARCH_MIN_LIMIT, parsed));
}

function parseSimilarLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return SIMILAR_DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return SIMILAR_DEFAULT_LIMIT;
  }

  return Math.min(SIMILAR_MAX_LIMIT, Math.max(SIMILAR_MIN_LIMIT, parsed));
}

function parseActivityDays(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return ACTIVITY_DEFAULT_DAYS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return ACTIVITY_DEFAULT_DAYS;
  }

  return Math.min(ACTIVITY_MAX_DAYS, Math.max(ACTIVITY_MIN_DAYS, parsed));
}

function parseActivityLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return ACTIVITY_DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return ACTIVITY_DEFAULT_LIMIT;
  }

  return Math.min(ACTIVITY_MAX_LIMIT, Math.max(ACTIVITY_MIN_LIMIT, parsed));
}

function parseSessionHistoryLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return SESSION_HISTORY_DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return SESSION_HISTORY_DEFAULT_LIMIT;
  }

  return Math.min(
    SESSION_HISTORY_MAX_LIMIT,
    Math.max(SESSION_HISTORY_MIN_LIMIT, parsed),
  );
}

function parseSessionTailLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return SESSION_TAIL_DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return SESSION_TAIL_DEFAULT_LIMIT;
  }

  return Math.min(
    SESSION_TAIL_MAX_LIMIT,
    Math.max(SESSION_TAIL_MIN_LIMIT, parsed),
  );
}

function parseStatsWeeks(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return STATS_DEFAULT_WEEKS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return STATS_DEFAULT_WEEKS;
  }

  return Math.min(STATS_MAX_WEEKS, Math.max(STATS_MIN_WEEKS, parsed));
}

function parseCfdDays(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return CFD_DEFAULT_DAYS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return CFD_DEFAULT_DAYS;
  }

  return Math.min(CFD_MAX_DAYS, Math.max(CFD_MIN_DAYS, parsed));
}

function parseClosedLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return BOARD_DEFAULT_CLOSED_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return BOARD_DEFAULT_CLOSED_LIMIT;
  }

  return Math.min(BOARD_MAX_CLOSED_LIMIT, Math.max(BOARD_MIN_CLOSED_LIMIT, parsed));
}

function parseProjectIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }

  const ids = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (ids.length === 0) {
    return undefined;
  }

  return ids;
}

function findProjectRootPathForTicket(
  cache: BoardCache,
  ticketId: string,
): string | undefined {
  for (const entry of cache.listProjects()) {
    if (entry.tickets.some((ticket) => ticket.id === ticketId)) {
      return entry.project.rootPath;
    }
  }
  return undefined;
}

function findCachedTicket(
  cache: BoardCache,
  ticketId: string,
): { readonly rootPath: string; readonly ticket: Ticket } | undefined {
  for (const entry of cache.listProjects()) {
    const ticket = entry.tickets.find((candidate) => candidate.id === ticketId);
    if (ticket !== undefined) {
      return { rootPath: entry.project.rootPath, ticket };
    }
  }
  return undefined;
}

/**
 * トランスクリプト自動推定リンク(source:'transcript')に、bdboard.session
 * メタデータ経由の手動リンクがあれば source:'metadata' として重ね書きする。
 * 同じセッションIDが両方から来た場合は手動リンクを優先する。
 */
function buildTicketSessionLinkDtos(
  transcriptLinks: readonly SessionLink[],
  manualSessionId: string | undefined,
): TicketSessionLinkDto[] {
  const bySessionId = new Map<string, TicketSessionLinkDto>();

  for (const link of transcriptLinks) {
    bySessionId.set(link.sessionId, {
      sessionId: link.sessionId,
      source: link.source,
    });
  }

  if (manualSessionId !== undefined) {
    bySessionId.set(manualSessionId, {
      sessionId: manualSessionId,
      source: 'metadata',
    });
  }

  return [...bySessionId.values()].sort((a, b) =>
    compareStrings(a.sessionId, b.sessionId),
  );
}

function relayEventName(
  name: string,
): name is
  | 'board.changed'
  | 'session.changed'
  | 'notification' {
  return (
    name === 'board.changed' ||
    name === 'session.changed' ||
    name === 'notification'
  );
}

/*
 * DTO 変換は liveness 閾値を必須で受け取る (bdboard-5kz2)。getBoardThresholds は
 * 任意の依存なので、未注入のときにどの値へ落ちるかをここ1箇所で明示する。
 * 各ハンドラで `?? DEFAULT_LIVENESS_THRESHOLDS` を書き散らすと、渡し忘れと
 * 「既定でよい」の区別がまた付かなくなる。
 */
async function resolveLivenessThresholds(
  deps: ApiDeps,
): Promise<LivenessThresholds> {
  const thresholds = await deps.getBoardThresholds?.();
  return thresholds?.livenessThresholds ?? DEFAULT_LIVENESS_THRESHOLDS;
}

async function buildGetBoardDeps(deps: ApiDeps): Promise<GetBoardDeps> {
  const thresholds = await deps.getBoardThresholds?.();
  const sessions = deps.sessions?.();
  const links = deps.links?.();
  return {
    cache: deps.cache,
    now: deps.now(),
    ...(sessions !== undefined ? { sessions } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(thresholds !== undefined
      ? {
          stalledThresholds: thresholds.stalledThresholds,
          livenessThresholds: thresholds.livenessThresholds,
        }
      : {}),
  };
}

export function createApiRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const prBadgeCommentCache = new PrBadgeCommentCache();
  const applicationVersion = deps.applicationVersion.getVersion();

  // 書き込みガードはここ 1 箇所だけ。ルート個別のチェックは持たない(bdboard-9rz)。
  // '*' でメソッド判定するので、この下に後から足された POST/PUT/PATCH/DELETE は
  // 登録しただけでガードの内側に入る。ハンドラが存在しないパスへの書き込みも
  // ルーティング解決より前に 403 になる(= ガード掛け忘れで出荷される経路が無い)。
  app.use('*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

  app.get('/api/health', (c) => {
    return c.json({ ok: true, now: deps.now().toISOString(), version: applicationVersion });
  });

  app.get('/api/status', (c) => {
    const status = deps.getStatus();
    return c.json({
      lastRefreshAt:
        status.lastRefreshAt !== null
          ? status.lastRefreshAt.toISOString()
          : null,
      errors: status.errors.map((error) => ({
        kind: error.kind,
        projectId: error.projectId,
        detail: error.detail,
      })),
      projectCount: status.projectCount,
      boardTimeZone: getBoardTimeZoneOverride() ?? null,
    });
  });

  app.get('/api/projects', async (c) => {
    const now = deps.now();
    // ユーザー設定の liveness 閾値を反映する (bdboard-3tw.102.5)。渡さないと
    // activeSessionCount = ヘッダーの「稼働中 N」だけが既定値のままになる。
    const livenessThresholds = await resolveLivenessThresholds(deps);
    const cachedProjects = deps.cache
      .listProjects()
      // Locale-independent, to match cache.listProjects()/getBoard ordering.
      .slice()
      .sort((a, b) => compareStrings(a.project.rootPath, b.project.rootPath));
    const allProjects = cachedProjects.map((entry) => entry.project);
    const sessionsByProject = groupSessionsByProject(
      deps.sessions?.() ?? [],
      allProjects,
    );

    const projects: ProjectDto[] = cachedProjects.map((entry) =>
      toProjectDto(entry.project, now, livenessThresholds, {
        sessions: sessionsByProject.get(entry.project.id),
        incompleteTicketCount: countIncompleteTicketsFromTickets(entry.tickets),
      }),
    );

    return c.json(projects);
  });

  app.get('/api/board', async (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const epicId = c.req.query('epicId');
    const viewRaw = c.req.query('view') ?? 'merged';
    const closedLimit = parseClosedLimit(c.req.query('closedLimit'));

    if (viewRaw !== 'merged' && viewRaw !== 'split') {
      return c.json(
        { error: 'invalid view', allowed: ['merged', 'split'] },
        400,
      );
    }

    const boardDeps = await buildGetBoardDeps(deps);
    const view = await getBoard(
      boardDeps,
      {
        ...(projectIds !== undefined ? { projectIds } : {}),
        ...(epicId !== undefined && epicId.length > 0 ? { epicId } : {}),
        mode: viewRaw,
        closedLimit,
      },
    );

    const sessionsByProject = groupSessionsByProject(
      deps.sessions?.() ?? [],
      view.projects.map((entry) => entry.project),
    );

    /*
     * ここは意図的に resolveLivenessThresholds を使わない (bdboard-5kz2)。
     * buildGetBoardDeps が既に getBoardThresholds を1回引いており、その同じ値を
     * getBoard (card.liveness をドメインで計算) とこの DTO 変換
     * (sessions[].liveness) の両方が使うことで、1リクエスト内の2つの liveness が
     * 必ず同じ閾値から出ることを保証している。ここで resolveLivenessThresholds を
     * 呼ぶと getBoardThresholds を2回引くことになり、その間に設定が変わると
     * バッジとセッション行が食い違う — bdboard-3tw.102.5 で潰したのと同じ不整合。
     * 上の resolveLivenessThresholds のコメントに従ってここを「整理」しないこと。
     * テストは getBoardThresholds に定数を注入するので、2回引きは緑のまま通る。
     */
    const dto = toBoardViewDto(
      view,
      boardDeps.livenessThresholds ?? DEFAULT_LIVENESS_THRESHOLDS,
      sessionsByProject,
    );
    const etag = computeWeakEtag(boardViewDtoStableJson(dto));

    c.header('ETag', etag);
    c.header('Cache-Control', 'no-cache');
    c.header('Vary', 'Accept-Encoding');

    const ifNoneMatch = c.req.header('If-None-Match');
    if (
      ifNoneMatch !== undefined &&
      ifNoneMatchMatches(ifNoneMatch, etag)
    ) {
      return c.body(null, 304);
    }

    return c.json(dto);
  });

  app.get('/api/search', (c) => {
    const query = c.req.query('q') ?? '';
    const limit = parseSearchLimit(c.req.query('limit'));

    const hits = searchTickets(deps.cache, { query, limit });
    return c.json(hits.map(toTicketSearchResultDto));
  });

  app.get('/api/activity', (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const days = parseActivityDays(c.req.query('days'));
    const limit = parseActivityLimit(c.req.query('limit'));

    const events = getActivityFeed(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      windowDays: days,
      limit,
    });

    return c.json(events.map(toActivityEventDto));
  });

  app.get('/api/stats', (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const weeks = parseStatsWeeks(c.req.query('weeks'));
    const stats = getThroughputStats(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      weeks,
    });
    return c.json(toThroughputStatsDto(stats));
  });

  app.get('/api/model-stats', (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const weeks = parseStatsWeeks(c.req.query('weeks'));
    const stats = getModelStats(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      weeks,
    });
    return c.json(toModelStatsDto(stats));
  });

  app.get('/api/cfd', (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const days = parseCfdDays(c.req.query('days'));
    const stats = getCfdStats(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      days,
    });
    return c.json(toCfdStatsDto(stats));
  });

  app.get('/api/hygiene', async (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));

    let leftoverCandidates: readonly LeftoverCandidate[] | undefined;
    if (deps.worktreeScanner !== undefined) {
      let entries = deps.cache.listProjects();
      if (projectIds !== undefined) {
        const filterSet = new Set(projectIds);
        entries = entries.filter((entry) => filterSet.has(entry.project.id));
      }
      const projects = entries.map((entry) => entry.project);
      leftoverCandidates = await scanGitLeftovers(projects, deps.worktreeScanner);
    }

    // 確認待ちの放置判定は最終コメント日時も見る (bdboard-19db)。bd の updated_at は
    // コメントで動かないので、これが無いとコメントで議論が続いているチケットまで
    // 「放置」に出る。引くのは確認待ちのチケットだけなので件数はひと桁。
    let pendingCommentAnchors: ReadonlyMap<string, Date> | undefined;
    if (deps.commentReader !== undefined) {
      pendingCommentAnchors = await getPendingCommentAnchors(
        deps.cache,
        deps.commentReader,
        projectIds !== undefined ? { projectIds } : undefined,
      );
    }

    const thresholds = await deps.getHygieneThresholds?.();

    const issues = getHygieneIssues(deps.cache, deps.now(), {
      ...(projectIds !== undefined ? { projectIds } : {}),
      ...(pendingCommentAnchors !== undefined ? { pendingCommentAnchors } : {}),
      ...(leftoverCandidates !== undefined ? { leftoverCandidates } : {}),
      ...(thresholds !== undefined ? { thresholds } : {}),
    });
    return c.json(issues.map(toHygieneIssueDto));
  });

  app.get('/api/lease-health', async (c) => {
    if (deps.leaseReader === undefined || deps.reclaimScheduler === undefined) {
      return c.json({ error: 'lease health not available' }, 501);
    }

    const projectIds = parseProjectIds(c.req.query('projects'));
    let entries = deps.cache.listProjects();
    if (projectIds !== undefined) {
      const filterSet = new Set(projectIds);
      entries = entries.filter((entry) => filterSet.has(entry.project.id));
    }

    const projects = entries.map((entry) => entry.project);
    const staleLeases = await getStaleLeaseIssues(
      projects,
      deps.leaseReader,
      deps.now(),
      projectIds !== undefined ? { projectIds } : undefined,
    );

    return c.json(
      toLeaseHealthDto({
        staleLeases,
        reclaim: deps.reclaimScheduler.getStatus(),
      }),
    );
  });

  app.get('/api/pr-links', async (c) => {
    if (deps.commentReader === undefined || deps.prStatusReader === undefined) {
      return c.json({ error: 'pr links not available' }, 501);
    }

    const projectIds = parseProjectIds(c.req.query('projects'));
    const badges = await getPrBadges(
      deps.cache,
      deps.commentReader,
      deps.prStatusReader,
      {
        ...(projectIds !== undefined ? { projectIds } : {}),
        commentCache: prBadgeCommentCache,
      },
    );
    return c.json(badges.map(toPrBadgeDto));
  });

  app.get('/api/merge-slot-status', async (c) => {
    if (deps.mergeSlotReader === undefined) {
      return c.json({ error: 'merge slot status not available' }, 501);
    }

    const projectIds = parseProjectIds(c.req.query('projects'));
    let entries = deps.cache.listProjects();
    if (projectIds !== undefined) {
      const filterSet = new Set(projectIds);
      entries = entries.filter((entry) => filterSet.has(entry.project.id));
    }

    const projects = entries.map((entry) => entry.project);
    const statuses = await getMergeSlotStatus(
      projects,
      deps.mergeSlotReader,
      deps.now(),
      projectIds !== undefined ? { projectIds } : undefined,
    );

    return c.json(statuses.map(toMergeSlotStatusDto));
  });

  app.get('/api/graph', (c) => {
    const projectIds = parseProjectIds(c.req.query('projects'));
    const graph = getDependencyGraph(deps.cache, {
      ...(projectIds !== undefined ? { projectIds } : {}),
    });
    return c.json(toDependencyGraphDto(graph));
  });

  app.get('/api/tickets/pending-decisions', (c) => {
    if (deps.humanDecisions === undefined) {
      return c.json({ error: 'pending decisions not available' }, 501);
    }

    const projects = deps.cache.listProjects();
    const result: PendingDecisionDto[] = [];

    for (const entry of projects) {
      for (const decision of entry.pendingDecisions ?? []) {
        result.push({
          id: decision.id,
          projectId: entry.project.id,
          ...(decision.question !== undefined ? { question: decision.question } : {}),
          ...(decision.options !== undefined
            ? {
                options: decision.options.map((option) => ({
                  label: option.label,
                  value: option.value,
                })),
              }
            : {}),
          allowFreeform: decision.allowFreeform,
        });
      }
    }

    return c.json(result);
  });

  app.get('/api/tickets/:id/timeline', (c) => {
    const id = c.req.param('id');
    const limit = parseActivityLimit(c.req.query('limit'));
    const events = getTicketTimeline(deps.cache, id, { limit });
    return c.json(events.map(toActivityEventDto));
  });

  app.get('/api/tickets/:id/similar', (c) => {
    const id = c.req.param('id');
    const limit = parseSimilarLimit(c.req.query('limit'));
    const hits = getSimilarTickets(deps.cache, id, { limit });
    return c.json(hits.map(toTicketSimilarResultDto));
  });

  app.get('/api/tickets/:id{.+}', async (c) => {
    const id = c.req.param('id');
    const links = deps.links?.();
    const view = await getBoard(await buildGetBoardDeps(deps), { mode: 'merged' });

    const card = view.merged?.cards.find((entry) => entry.ticket.id === id);
    if (card === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const transcriptLinks = (links ?? []).filter((link) => link.ticketId === id);
    const sessionLinks = buildTicketSessionLinkDtos(
      transcriptLinks,
      card.ticket.manualSessionId,
    );

    const cardsById = new Map(view.merged?.cards.map((entry) => [entry.ticket.id, entry]) ?? []);
    const childrenIndex = buildDirectChildrenIndex(
      view.merged?.cards.map((entry) => entry.ticket) ?? [],
    );
    const children: TicketChildDto[] = (childrenIndex.get(id) ?? [])
      .map((childId) => cardsById.get(childId))
      .filter((child): child is NonNullable<typeof child> => child !== undefined)
      .map((child) => ({
        id: child.ticket.id,
        title: child.ticket.title,
        lane: child.lane,
      }));

    const detail = toTicketDetailDto(card, sessionLinks, card.ticket.models ?? [], children);
    if (links !== undefined) {
      const usage = getTicketTokenUsage(id, links, deps.cache);
      if (hasTicketTokenUsage(usage)) {
        return c.json({
          ...detail,
          usage: toTicketTokenUsageDto(usage),
        });
      }
    }

    return c.json(detail);
  });

  app.post('/api/tickets/:id/decision', async (c) => {
    if (deps.humanDecisions === undefined) {
      return c.json({ error: 'pending decisions not available' }, 501);
    }

    const id = c.req.param('id');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = decisionBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const trimmedFreeform = parsed.data.freeform?.trim();
    const responseText =
      trimmedFreeform !== undefined && trimmedFreeform.length > 0
        ? trimmedFreeform
        : parsed.data.choice;

    if (responseText === undefined || responseText.length === 0) {
      return c.json({ error: 'choice or freeform is required' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.humanDecisions.respond(rootPath, id, responseText);
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to respond', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'failed to respond', detail }, 502);
    }
  });

  app.post('/api/tickets/:id/quick-action', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'quick actions not available' }, 501);
    }

    const id = c.req.param('id');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = quickActionBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      switch (parsed.data.action) {
        case 'claim':
          await deps.issueWriter.claim(rootPath, id);
          break;
        case 'close':
          await deps.issueWriter.close(
            rootPath,
            id,
            parsed.data.reason,
          );
          break;
        case 'defer':
          await deps.issueWriter.defer(rootPath, id, parsed.data.untilDate);
          break;
        case 'undefer':
          await deps.issueWriter.undefer(rootPath, id);
          break;
        case 'priority':
          await deps.issueWriter.setPriority(
            rootPath,
            id,
            parsed.data.priority,
          );
          break;
      }

      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof StatusConflictError) {
        // bdboard-3tw.93: `bd undefer`/`bd reopen` は前提を満たさなくても exit 0 で
        // no-op する。issueWriter 側の read-then-write CAS が StatusConflictError を
        // 投げるので、それを 502 の汎用エラーに潰さず 409 として返す。502 だと UI が
        // 『サーバー障害』と見分けられず、偽の成功表示や不適切なリトライにつながる。
        return c.json(
          {
            error: 'status changed since quick action',
            detail: error.message,
            expectedStatus: error.expectedStatus,
            currentStatus: error.actualStatus,
          },
          409,
        );
      }

      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to run quick action', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'failed to run quick action', detail }, 502);
    }
  });

  app.post('/api/tickets/:id/quick-action/undo', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'quick actions not available' }, 501);
    }

    const id = c.req.param('id');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = quickActionUndoBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      switch (parsed.data.action) {
        case 'claim':
          await deps.issueWriter.unclaim(rootPath, id);
          break;
        case 'close':
          await deps.issueWriter.reopen(rootPath, id);
          break;
        case 'defer':
          await deps.issueWriter.undefer(rootPath, id);
          break;
        case 'undefer':
          // action:'defer' の undo が undefer() を呼ぶのと対になる。undefer の逆操作は
          // 『元の defer 日付へ戻す』なので、priority と同様に呼び出し元が実行前の値
          // (untilDate)を渡す必要がある。
          await deps.issueWriter.defer(rootPath, id, parsed.data.untilDate);
          break;
        case 'priority':
          await deps.issueWriter.undoPriority(
            rootPath,
            id,
            parsed.data.expectedCurrentPriority,
            parsed.data.previousPriority,
          );
          break;
      }

      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof PriorityConflictError) {
        // bdboard-3tw.82: Undo を押すまでの間に別セッションが優先度を変えていた。
        // 上書きせずに 409 を返す — UI 側はこれを「他のセッションが変更しました」として
        // 表示する(web/src/components/UndoSnackbar.tsx の describeUndoError)。
        return c.json(
          {
            error: 'priority changed since quick action',
            detail: error.message,
            expectedPriority: error.expectedPriority,
            currentPriority: error.actualPriority,
          },
          409,
        );
      }

      if (error instanceof StatusConflictError) {
        // bdboard-3tw.93: close/defer の Undo(reopen/undefer)を押すまでの間に別
        // セッションがステータスを変えていた(あるいは bd reopen/undefer が前提を
        // 満たさず exit 0 で no-op しただけだった)。上書きせず 409 を返す — UI 側は
        // これも PriorityConflictError と同じ 409 分岐で「他のセッションが変更しました」
        // として表示する(web/src/components/UndoSnackbar.tsx の describeUndoError)。
        return c.json(
          {
            error: 'status changed since quick action',
            detail: error.message,
            expectedStatus: error.expectedStatus,
            currentStatus: error.actualStatus,
          },
          409,
        );
      }

      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to undo quick action', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'failed to undo quick action', detail }, 502);
    }
  });

  app.post('/api/tickets/:id/dependencies', async (c) => {
    if (deps.dependencyWriter === undefined) {
      return c.json({ error: 'dependency editing not available' }, 501);
    }

    const id = c.req.param('id');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = dependencyBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const { dependsOnId } = parsed.data;

    if (dependsOnId === id) {
      return c.json({ error: 'cannot depend on itself' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const dependsOnRootPath = findProjectRootPathForTicket(
      deps.cache,
      dependsOnId,
    );
    if (dependsOnRootPath === undefined || dependsOnRootPath !== rootPath) {
      return c.json(
        { error: 'dependency target must be in the same project' },
        400,
      );
    }

    try {
      await deps.dependencyWriter.addDependency(rootPath, id, dependsOnId);
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to add dependency', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'failed to add dependency', detail }, 502);
    }
  });

  app.delete('/api/tickets/:id/dependencies/:dependsOnId{.+}', async (c) => {
    if (deps.dependencyWriter === undefined) {
      return c.json({ error: 'dependency editing not available' }, 501);
    }

    const id = c.req.param('id');
    const dependsOnId = c.req.param('dependsOnId');

    const cached = findCachedTicket(deps.cache, id);
    if (cached === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const edge = cached.ticket.dependencies.find(
      (dependency) => dependency.dependsOnId === dependsOnId,
    );
    // キャッシュに無いエッジは bd に投げずにここで弾く。削除ボタンはキャッシュ上の
    // blocks エッジにしか出ないので、見つからない = クライアントが古い、ということ。
    // そのまま bd dep remove へ流すと、キャッシュが stale な間に parent-child を
    // 消してしまいうる(kind を判定できないため)。破壊的操作なので fail-closed にする。
    if (edge === undefined) {
      return c.json(
        { error: 'dependency not found on this ticket', id, dependsOnId },
        409,
      );
    }
    if (edge.kind !== 'blocks') {
      return c.json(
        { error: 'only blocks dependencies can be removed', kind: edge.kind },
        400,
      );
    }

    try {
      await deps.dependencyWriter.removeDependency(
        cached.rootPath,
        id,
        dependsOnId,
      );
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to remove dependency', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'failed to remove dependency', detail }, 502);
    }
  });

  app.patch('/api/tickets/:id/title', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'ticket content editing not available' }, 501);
    }

    const id = c.req.param('id');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = updateTitleBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.issueWriter.updateTitle(
        rootPath,
        id,
        parsed.data.title,
        parsed.data.expectedCurrentTitle,
      );
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof ContentConflictError) {
        return c.json(
          {
            error: 'title changed since loaded',
            detail: error.message,
            expectedTitle: error.expectedValue,
            currentTitle: error.actualValue,
          },
          409,
        );
      }

      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to update title', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'failed to update title', detail }, 502);
    }
  });

  app.patch('/api/tickets/:id/description', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'ticket content editing not available' }, 501);
    }

    const id = c.req.param('id');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = updateDescriptionBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.issueWriter.updateDescription(
        rootPath,
        id,
        parsed.data.description,
        parsed.data.expectedCurrentDescription,
      );
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof ContentConflictError) {
        return c.json(
          {
            error: 'description changed since loaded',
            detail: error.message,
            expectedDescription: error.expectedValue,
            currentDescription: error.actualValue,
          },
          409,
        );
      }

      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to update description', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'failed to update description', detail }, 502);
    }
  });

  app.post('/api/tickets/:id/labels', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'label editing not available' }, 501);
    }

    const id = c.req.param('id');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = labelBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.issueWriter.addLabel(rootPath, id, parsed.data.label);
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to add label', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'failed to add label', detail }, 502);
    }
  });

  app.delete('/api/tickets/:id/labels/:label{.+}', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'label editing not available' }, 501);
    }

    const id = c.req.param('id');
    const label = c.req.param('label');

    if (!isSafeCliArgument(label)) {
      return c.json({ error: 'invalid label' }, 400);
    }

    const cached = findCachedTicket(deps.cache, id);
    if (cached === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const currentLabels = cached.ticket.labels ?? [];
    if (!currentLabels.includes(label)) {
      return c.json(
        { error: 'label not found on this ticket', id, label },
        409,
      );
    }

    try {
      await deps.issueWriter.removeLabel(cached.rootPath, id, label);
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to remove label', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'failed to remove label', detail }, 502);
    }
  });

  app.post('/api/tickets/:id/session-link', async (c) => {
    if (deps.sessionLinkWriter === undefined) {
      return c.json({ error: 'session linking not available' }, 501);
    }

    const id = c.req.param('id');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = sessionLinkBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.sessionLinkWriter.linkSession(
        rootPath,
        id,
        parsed.data.sessionId,
      );
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to link session', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'failed to link session', detail }, 502);
    }
  });

  app.delete('/api/tickets/:id/session-link', async (c) => {
    if (deps.sessionLinkWriter === undefined) {
      return c.json({ error: 'session linking not available' }, 501);
    }

    const id = c.req.param('id');

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.sessionLinkWriter.unlinkSession(rootPath, id);
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to unlink session', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'failed to unlink session', detail }, 502);
    }
  });

  app.post('/api/tickets/:id/comment', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'comments not available' }, 501);
    }

    const id = c.req.param('id');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = commentBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.issueWriter.addComment(rootPath, id, parsed.data.text);

      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to add comment', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'failed to add comment', detail }, 502);
    }
  });

  app.get('/api/comments/:id{.+}', async (c) => {
    if (deps.commentReader === undefined) {
      return c.json({ error: 'comments not available' }, 501);
    }

    const id = c.req.param('id');
    const view = await getBoard(await buildGetBoardDeps(deps), { mode: 'merged' });

    const card = view.merged?.cards.find((entry) => entry.ticket.id === id);
    if (card === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const cached = deps.cache.getProject(card.projectId);
    if (cached === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      const comments = await deps.commentReader.listComments(
        cached.project.rootPath,
        card.ticket.id,
      );
      return c.json(comments.map(toCommentDto));
    } catch (error: unknown) {
      if (error instanceof BdError) {
        return c.json(
          { error: 'failed to load comments', detail: error.detail },
          502,
        );
      }

      const detail = error instanceof Error ? error.message : String(error);
      return c.json(
        { error: 'failed to load comments', detail },
        502,
      );
    }
  });

  app.get('/api/sessions/history', async (c) => {
    const now = deps.now();
    const livenessThresholds = await resolveLivenessThresholds(deps);
    const limit = parseSessionHistoryLimit(c.req.query('limit'));
    const projectIds = parseProjectIds(c.req.query('projects'));
    const sessions = deps.sessions?.() ?? [];
    const links = deps.links?.() ?? [];
    const history = getSessionHistory(sessions, links, deps.cache, {
      limit,
      ...(projectIds !== undefined ? { projectIds } : {}),
    });

    return c.json(
      history.map((entry) =>
        toSessionHistoryEntryDto(entry, now, livenessThresholds),
      ),
    );
  });

  app.get('/api/sessions/:id/tail', async (c) => {
    if (deps.sessionTail === undefined) {
      return c.json({ error: 'session tail reader not available' }, 501);
    }

    const id = c.req.param('id');
    const limit = parseSessionTailLimit(c.req.query('lines'));
    const sessions = deps.sessions?.() ?? [];
    const session = sessions.find((entry) => entry.sessionId === id);
    if (session === undefined) {
      return c.json({ error: 'session not found' }, 404);
    }

    const projects = deps.cache.listProjects().map((entry) => entry.project);
    const project = resolveSessionProject(session.cwd, projects);
    if (project === undefined) {
      return c.json({ error: 'session not found' }, 404);
    }

    const messages = await deps.sessionTail.readTail(session, limit);
    if (messages === undefined) {
      return c.json({ error: 'transcript not found' }, 404);
    }

    return c.json({
      sessionId: session.sessionId,
      messages: messages.map(toSessionTailMessageDto),
    });
  });

  app.get('/api/sessions', async (c) => {
    const now = deps.now();
    const livenessThresholds = await resolveLivenessThresholds(deps);
    const sessions = deps.sessions?.() ?? [];
    return c.json(
      sessions.map((session) => toSessionDto(session, now, livenessThresholds)),
    );
  });

  app.get('/api/processes', async (c) => {
    if (deps.processScanner === undefined) {
      return c.json({ error: 'process scanner not available' }, 501);
    }

    const scanned = await deps.processScanner.listAgentProcesses();
    const listed = listAgentProcesses(scanned, deps.cache);
    return c.json(listed.map(toAgentProcessDto));
  });

  app.post('/api/refresh', async (c) => {
    try {
      await deps.refresh();
      return c.json({ ok: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'refresh failed', detail }, 500);
    }
  });

  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      const queue: QueuedSseMessage[] = [];
      let wake: (() => void) | undefined;
      let cleanedUp = false;
      let clientGone = false;
      let pingTimer: ReturnType<typeof setInterval> | undefined;

      const waitForQueue = (): Promise<void> =>
        new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length > 0 || clientGone) {
            wake = undefined;
            resolve();
          }
        });

      const wakeUp = (): void => {
        const resume = wake;
        wake = undefined;
        resume?.();
      };

      const enqueue = (message: QueuedSseMessage): void => {
        queue.push(message);
        wakeUp();
      };

      // NOTE: Hono only bridges `c.req.raw.signal` to `stream.abort()` on old Bun
      // versions. On Node, `stream.onAbort` fires only when the response readable
      // is cancelled, so a client that aborts its request signal would otherwise
      // leak this subscription and the ping timer forever. Listen to both.
      const signal = c.req.raw.signal;

      const cleanup = (): void => {
        clientGone = true;
        wakeUp();

        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        unsubscribe();
        signal.removeEventListener('abort', cleanup);
        if (pingTimer !== undefined) {
          clearInterval(pingTimer);
          pingTimer = undefined;
        }
      };

      const unsubscribe = deps.events.subscribe((event) => {
        if (!relayEventName(event.name)) {
          return;
        }

        enqueue({
          event: event.name,
          data: JSON.stringify(event.data),
        });
      });

      stream.onAbort(() => {
        cleanup();
      });

      if (signal.aborted) {
        cleanup();
        return;
      }
      signal.addEventListener('abort', cleanup);

      pingTimer = setInterval(() => {
        enqueue({
          event: 'ping',
          data: JSON.stringify({ now: deps.now().toISOString() }),
        });
      }, 15_000);

      await stream.writeSSE({
        event: 'hello',
        data: JSON.stringify({ now: deps.now().toISOString() }),
      });

      try {
        while (!clientGone && !stream.aborted && !stream.closed) {
          while (queue.length > 0) {
            const message = queue.shift();
            if (message !== undefined) {
              await stream.writeSSE(message);
            }
          }

          if (clientGone || stream.aborted || stream.closed) {
            break;
          }

          await waitForQueue();
        }
      } finally {
        cleanup();
      }
    });
  });

  return app;
}
