import { compareStrings } from './compare.js';
import { isBlockingKind } from './dependency.js';
import { computeStronglyConnectedComponents } from './graph-scc.js';
import {
  buildDirectChildrenIndex,
  epicProgressFromIndex,
} from './epic-progress.js';
import {
  createReadinessContext,
  isReady,
  type ReadinessContext,
} from './readiness.js';
import type { LeftoverCandidate } from './git-worktree.js';
import { isOpenLike, isPriority } from './status.js';
import {
  resolveHygieneThresholds,
  type HygieneThresholds,
  type HygieneThresholdsOverrides,
} from './hygiene-thresholds.js';

export type { HygieneThresholds, HygieneThresholdsOverrides } from './hygiene-thresholds.js';
export { DEFAULT_HYGIENE_THRESHOLDS } from './hygiene-thresholds.js';
import type { Ticket } from './ticket.js';
import type { TicketId } from './ticket-id.js';

export type HygieneIssueKind =
  | 'dependency_cycle'
  | 'overdue_defer'
  | 'stale_epic'
  | 'stale_in_progress'
  | 'missing_priority'
  | 'unblocked_high_priority_idle'
  | 'stale_pending_decision'
  | 'merged_leftover';

export interface HygieneCycleEdge {
  readonly issueId: TicketId;
  readonly dependsOnId: TicketId;
}

export interface HygieneCleanupTarget {
  readonly repoRootPath: string;
  readonly worktreePath: string | null;
  readonly branchName: string | null;
}

export interface HygieneIssue {
  readonly kind: HygieneIssueKind;
  readonly ticketId: TicketId;
  readonly projectId: string;
  readonly message: string;
  readonly severity: 'warning' | 'info';
  /** merged_leftover のときだけ入る。UI が掃除コマンド文字列を組み立てる材料 */
  readonly cleanup?: HygieneCleanupTarget;
  /** overdue_defer のときだけ入る。Undo で元の日付へ戻すための材料 */
  readonly deferUntil?: string;
  /** dependency_cycle のときだけ入る */
  readonly cycleTicketIds?: readonly TicketId[];
  /** dependency_cycle のときだけ入る */
  readonly cycleEdges?: readonly HygieneCycleEdge[];
}

/**
 * 確認待ち集合のキー。
 *
 * ticket.id だけで持つと、同じIDのチケットを持つ別プロジェクトが同時にスコープへ
 * 入っているときに取り違える。bd のIDはプロジェクト内でしか一意ではなく、盤面側は
 * humanLabeledIdsFromCache を **プロジェクト単位** で作っている
 * (src/application/board/get-board.ts) ので、健全性だけ全プロジェクト混ぜた集合で
 * 判定すると、盤面では通常レーンのチケットに「確認待ちが放置されている」が付く。
 * 依存循環の辺キー(collectCycleEdges)と同じ \0 結合で projectId を前置する。
 */
export function pendingDecisionKey(
  projectId: string,
  ticketId: TicketId,
): string {
  return `${projectId}\0${ticketId}`;
}

function ticketPriority(ticket: Ticket): unknown {
  return (ticket as { readonly priority?: unknown }).priority;
}

function isMissingPriority(ticket: Ticket): boolean {
  return !isPriority(ticketPriority(ticket));
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function inProgressAnchor(ticket: Ticket): Date | null {
  if (isValidDate(ticket.startedAt)) {
    return ticket.startedAt;
  }
  if (isValidDate(ticket.updatedAt)) {
    return ticket.updatedAt;
  }
  return null;
}

function hasBlockingDependencies(ticket: Ticket): boolean {
  return ticket.dependencies.some(
    (edge) => isBlockingKind(edge.kind) && edge.issueId === ticket.id,
  );
}

/**
 * Date を YYYY-MM-DD に整形する。
 *
 * timeZone 未指定時は実行環境のローカルタイムゾーン(getFullYear/getMonth/getDate)。
 * 指定時はその IANA タイムゾーンの暦日(UTC で slice すると JST では 1 日ずれる)。
 */
export function formatLocalDateKey(date: Date, timeZone?: string): string {
  if (timeZone !== undefined) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function checkOverdueDefer(
  ticket: Ticket,
  now: Date,
  timeZone?: string,
): HygieneIssue | null {
  if (ticket.status !== 'deferred') {
    return null;
  }
  if (!isValidDate(ticket.deferUntil)) {
    return null;
  }
  if (ticket.deferUntil.getTime() > now.getTime()) {
    return null;
  }

  // `bd defer --until=2026-08-10` は JST 深夜として `2026-08-09T15:00:00Z` に保存されるため、
  // `toISOString().slice(0,10)` のように UTC で切ると 1 日ずれる。Undo で元の日付へ戻すときに
  // ずれると別の日付に defer し直してしまうので、ローカルタイムゾーンで整形する。
  return {
    kind: 'overdue_defer',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: 'defer_until を過ぎていますが、まだ deferred のままです',
    severity: 'warning',
    deferUntil: formatLocalDateKey(ticket.deferUntil, timeZone),
  };
}

function checkStaleEpic(
  ticket: Ticket,
  childrenIndex: ReadonlyMap<TicketId, readonly TicketId[]>,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): HygieneIssue | null {
  if (ticket.status === 'closed') {
    return null;
  }

  const progress = epicProgressFromIndex(ticket.id, childrenIndex, ticketById);
  if (progress === null || progress.total === 0 || progress.done !== progress.total) {
    return null;
  }

  return {
    kind: 'stale_epic',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: '子チケットはすべて完了していますが、エピックが open のままです',
    severity: 'warning',
  };
}

function checkStaleInProgress(
  ticket: Ticket,
  now: Date,
  thresholds: HygieneThresholds,
  isPendingDecision: boolean,
): HygieneIssue | null {
  if (ticket.status !== 'in_progress' && ticket.status !== 'hooked') {
    return null;
  }
  // 確認待ちは stale_pending_decision の担当。deriveLane が human ラベルを
  // in_progress より優先する(src/domain/readiness.ts)ので、盤面が確認待ちに
  // 置いているカードに対して「長期 in_progress」と言うと、盤面に無いレーンの話に
  // なるうえ、同じ放置を2行で叱ることになる。
  if (isPendingDecision) {
    return null;
  }

  const anchor = inProgressAnchor(ticket);
  if (anchor === null) {
    return null;
  }

  const elapsedMs = now.getTime() - anchor.getTime();
  if (elapsedMs < thresholds.staleInProgressAfterMs) {
    return null;
  }

  const days = Math.floor(elapsedMs / (24 * 60 * 60_000));
  return {
    kind: 'stale_in_progress',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: `in_progress のまま ${days} 日以上経過しています`,
    severity: 'warning',
  };
}

function checkMissingPriority(ticket: Ticket): HygieneIssue | null {
  if (!isMissingPriority(ticket)) {
    return null;
  }

  return {
    kind: 'missing_priority',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: 'priority が未設定または不正です',
    severity: 'info',
  };
}

function checkUnblockedHighPriorityIdle(
  ticket: Ticket,
  ctx: ReadinessContext,
  now: Date,
  thresholds: HygieneThresholds,
): HygieneIssue | null {
  if (!isOpenLike(ticket.status)) {
    return null;
  }
  if (isMissingPriority(ticket)) {
    return null;
  }
  const priority = ticketPriority(ticket);
  if (
    typeof priority !== 'number' ||
    priority > thresholds.highPriorityMax
  ) {
    return null;
  }
  if (!hasBlockingDependencies(ticket)) {
    return null;
  }
  if (!isReady(ticket, ctx, now)) {
    return null;
  }

  return {
    kind: 'unblocked_high_priority_idle',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: 'ブロックは解除済みですが、高優先チケットが未着手のままです',
    severity: 'warning',
  };
}

/**
 * 確認待ち(awaiting_human)のまま放置されているチケットを拾う。
 *
 * awaiting_human は ticket.status ではなく bd の human ラベル由来の派生レーンで
 * (src/domain/readiness.ts の deriveLane)、Ticket 単体からは判定できない。呼び出し側が
 * 集めた pendingDecisionKeys を渡してもらう前提で、渡されなければ何も出さない。
 *
 * closed は除外する。deriveLane も closed を done で上書きしていて(human ラベルの
 * 外し忘れでチケットが再浮上しないための保険)、盤面で done のカードが健全性だけ
 * 「確認待ちが放置されている」と言い出すのは矛盾になる。
 */
function checkStalePendingDecision(
  ticket: Ticket,
  now: Date,
  thresholds: HygieneThresholds,
  isPendingDecision: boolean,
  lastCommentAt: Date | undefined,
): HygieneIssue | null {
  if (!isPendingDecision) {
    return null;
  }
  if (ticket.status === 'closed') {
    return null;
  }
  if (!isValidDate(ticket.updatedAt)) {
    return null;
  }

  // 遅いほうを取る。コメントのほうが古いこと自体は普通にある(コメント後に
  // 優先度を変えた等)ので、どちらか一方に決め打ちはしない。
  const anchor =
    isValidDate(lastCommentAt) && lastCommentAt.getTime() > ticket.updatedAt.getTime()
      ? lastCommentAt
      : ticket.updatedAt;

  const elapsedMs = now.getTime() - anchor.getTime();
  if (elapsedMs < thresholds.stalePendingDecisionAfterMs) {
    return null;
  }

  const days = Math.floor(elapsedMs / (24 * 60 * 60_000));
  return {
    kind: 'stale_pending_decision',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: `確認待ちのまま ${days} 日以上動きがありません`,
    severity: 'warning',
  };
}

function checkMergedLeftover(
  candidate: LeftoverCandidate,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): HygieneIssue | null {
  if (candidate.worktreePath === null && candidate.branchName === null) {
    return null;
  }

  const ticket = ticketById.get(candidate.ticketId);
  if (ticket === undefined) {
    return null;
  }
  if (ticket.status !== 'closed') {
    return null;
  }
  if (ticket.projectId !== candidate.projectId) {
    return null;
  }

  let message: string;
  if (candidate.worktreePath !== null && candidate.branchName !== null) {
    message = 'チケットは closed ですが worktree とブランチが残っています';
  } else if (candidate.worktreePath !== null) {
    message = 'チケットは closed ですが worktree が残っています';
  } else {
    message = 'チケットは closed ですがブランチが残っています';
  }

  return {
    kind: 'merged_leftover',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message,
    severity: 'warning',
    cleanup: {
      repoRootPath: candidate.repoRootPath,
      worktreePath: candidate.worktreePath,
      branchName: candidate.branchName,
    },
  };
}

export interface DependencyCycle {
  readonly ticketIds: readonly TicketId[];
  readonly edges: readonly HygieneCycleEdge[];
}

function buildBlocksIndex(
  tickets: readonly Ticket[],
  ticketById: ReadonlyMap<TicketId, Ticket>,
): Map<TicketId, TicketId[]> {
  const index = new Map<TicketId, TicketId[]>();

  for (const ticket of tickets) {
    for (const edge of ticket.dependencies) {
      if (edge.kind !== 'blocks') {
        continue;
      }
      if (!ticketById.has(edge.issueId) || !ticketById.has(edge.dependsOnId)) {
        continue;
      }

      let successors = index.get(edge.dependsOnId);
      if (successors === undefined) {
        successors = [];
        index.set(edge.dependsOnId, successors);
      }
      successors.push(edge.issueId);
    }
  }

  return index;
}

function compareCycleEdges(
  a: HygieneCycleEdge,
  b: HygieneCycleEdge,
): number {
  const issueDiff = compareStrings(a.issueId, b.issueId);
  if (issueDiff !== 0) {
    return issueDiff;
  }
  return compareStrings(a.dependsOnId, b.dependsOnId);
}

function collectCycleEdges(
  tickets: readonly Ticket[],
  memberSet: ReadonlySet<TicketId>,
): readonly HygieneCycleEdge[] {
  const seen = new Set<string>();
  const edges: HygieneCycleEdge[] = [];

  for (const ticket of tickets) {
    for (const edge of ticket.dependencies) {
      if (edge.kind !== 'blocks') {
        continue;
      }
      if (!memberSet.has(edge.issueId) || !memberSet.has(edge.dependsOnId)) {
        continue;
      }

      const key = `${edge.issueId}\0${edge.dependsOnId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({ issueId: edge.issueId, dependsOnId: edge.dependsOnId });
    }
  }

  return edges.sort(compareCycleEdges);
}

export function findDependencyCycles(
  tickets: readonly Ticket[],
): readonly DependencyCycle[] {
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const blocksIndex = buildBlocksIndex(tickets, ticketById);

  function neighbors(id: TicketId): readonly TicketId[] {
    return (blocksIndex.get(id) ?? []).filter((successor) => ticketById.has(successor));
  }

  const { sccMembers } = computeStronglyConnectedComponents(
    tickets.map((ticket) => ticket.id),
    neighbors,
  );

  const cycles: DependencyCycle[] = [];

  for (const component of sccMembers) {
    if (component.length < 2) {
      continue;
    }

    const ticketIds = [...component].sort(compareStrings);
    const memberSet = new Set(ticketIds);
    const edges = collectCycleEdges(tickets, memberSet);
    cycles.push({ ticketIds, edges });
  }

  return cycles.sort((a, b) => compareStrings(a.ticketIds[0]!, b.ticketIds[0]!));
}

const KIND_ORDER: readonly HygieneIssueKind[] = [
  'dependency_cycle',
  'overdue_defer',
  'stale_epic',
  'stale_in_progress',
  'missing_priority',
  'unblocked_high_priority_idle',
  'stale_pending_decision',
  'merged_leftover',
];

function compareIssues(a: HygieneIssue, b: HygieneIssue): number {
  const kindDiff = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (kindDiff !== 0) {
    return kindDiff;
  }
  const projectDiff = compareStrings(a.projectId, b.projectId);
  if (projectDiff !== 0) {
    return projectDiff;
  }
  return compareStrings(a.ticketId, b.ticketId);
}

export function checkHygiene(
  tickets: readonly Ticket[],
  ctx: {
    readonly now: Date;
    readonly thresholds?: HygieneThresholdsOverrides;
    readonly leftoverCandidates?: readonly LeftoverCandidate[];
    /**
     * 確認待ち(awaiting_human)のチケット。bd の human ラベル由来で Ticket からは
     * 判定できないため、呼び出し側が集めて渡す。キーは pendingDecisionKey() で
     * projectId を前置したもの。未指定なら stale_pending_decision は一切出ない。
     */
    readonly pendingDecisionKeys?: ReadonlySet<string>;
    /**
     * 確認待ちチケットの最終コメント日時。キーは pendingDecisionKeys と同じ
     * pendingDecisionKey()。stale_pending_decision のアンカーを
     * max(updatedAt, ここの値) にするためだけに使う。未指定なら updatedAt のみ。
     */
    readonly pendingCommentAnchors?: ReadonlyMap<string, Date>;
    readonly timeZone?: string;
  },
): readonly HygieneIssue[] {
  const thresholds = resolveHygieneThresholds(ctx.thresholds);
  const readiness = createReadinessContext(tickets);
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const childrenIndex = buildDirectChildrenIndex(tickets);
  const issues: HygieneIssue[] = [];

  for (const ticket of tickets) {
    const overdueDefer = checkOverdueDefer(ticket, ctx.now, ctx.timeZone);
    if (overdueDefer !== null) {
      issues.push(overdueDefer);
    }

    const staleEpic = checkStaleEpic(ticket, childrenIndex, ticketById);
    if (staleEpic !== null) {
      issues.push(staleEpic);
    }

    const decisionKey = pendingDecisionKey(ticket.projectId, ticket.id);
    const isPendingDecision = ctx.pendingDecisionKeys?.has(decisionKey) ?? false;

    const staleInProgress = checkStaleInProgress(
      ticket,
      ctx.now,
      thresholds,
      isPendingDecision,
    );
    if (staleInProgress !== null) {
      issues.push(staleInProgress);
    }

    const stalePendingDecision = checkStalePendingDecision(
      ticket,
      ctx.now,
      thresholds,
      isPendingDecision,
      ctx.pendingCommentAnchors?.get(decisionKey),
    );
    if (stalePendingDecision !== null) {
      issues.push(stalePendingDecision);
    }

    const missingPriority = checkMissingPriority(ticket);
    if (missingPriority !== null) {
      issues.push(missingPriority);
    }

    const unblockedIdle = checkUnblockedHighPriorityIdle(
      ticket,
      readiness,
      ctx.now,
      thresholds,
    );
    if (unblockedIdle !== null) {
      issues.push(unblockedIdle);
    }
  }

  if (ctx.leftoverCandidates !== undefined) {
    for (const candidate of ctx.leftoverCandidates) {
      const mergedLeftover = checkMergedLeftover(candidate, ticketById);
      if (mergedLeftover !== null) {
        issues.push(mergedLeftover);
      }
    }
  }

  for (const cycle of findDependencyCycles(tickets)) {
    const representativeId = cycle.ticketIds[0]!;
    const representative = ticketById.get(representativeId);
    if (representative === undefined) {
      continue;
    }

    issues.push({
      kind: 'dependency_cycle',
      ticketId: representativeId,
      projectId: representative.projectId,
      message: `${cycle.ticketIds.length}件のチケットが循環依存(blocks)しています: ${cycle.ticketIds.join(', ')}`,
      severity: 'warning',
      cycleTicketIds: cycle.ticketIds,
      cycleEdges: cycle.edges,
    });
  }

  return [...issues].sort(compareIssues);
}
