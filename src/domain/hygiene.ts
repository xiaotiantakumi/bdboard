import { isBlockingKind } from './dependency.js';
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

export interface HygieneThresholds {
  /**
   * 既定 7日。
   *
   * stalled（24時間・セッション無し）とは別軸で、「in_progress のまま長期間経過」を
   * 台帳の腐りとして拾う。startedAt があればそこから、無ければ updatedAt から測る。
   */
  readonly staleInProgressAfterMs: number;
  /** P0/P1 を高優先とみなす上限（この値以下） */
  readonly highPriorityMax: number;
  /**
   * 既定 3日。
   *
   * 確認待ち(awaiting_human)のまま動きが無いチケットを拾う。in_progress の 7日より
   * 短いのは、待っているのが人間の返答1つで、待たせている側(エージェント)は
   * その間ずっと止まっているため。
   *
   * 測るのは updatedAt からの経過。bd human list が返す PendingDecision には
   * 「いつ質問が出たか」が無い(src/application/ports/human-decisions.ts)ので、
   * 「質問が出てから何日」ではなく「このチケットに何も起きていない期間」を見る。
   * コメントやメタデータ更新でリセットされるが、放置の検知としてはむしろ
   * こちらが欲しい意味になる。
   */
  readonly stalePendingDecisionAfterMs: number;
}

export const DEFAULT_HYGIENE_THRESHOLDS: HygieneThresholds = {
  staleInProgressAfterMs: 7 * 24 * 60 * 60_000,
  highPriorityMax: 1,
  stalePendingDecisionAfterMs: 3 * 24 * 60 * 60_000,
};

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

/** Date をローカルタイムゾーンの YYYY-MM-DD に整形する(UTC で切ると JST では 1 日ずれる) */
export function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function checkOverdueDefer(
  ticket: Ticket,
  now: Date,
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
    deferUntil: formatLocalDateKey(ticket.deferUntil),
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
): HygieneIssue | null {
  if (ticket.status !== 'in_progress' && ticket.status !== 'hooked') {
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
 * 集めた pendingDecisionIds を渡してもらう前提で、渡されなければ何も出さない。
 *
 * closed は除外する。deriveLane も closed を done で上書きしていて(human ラベルの
 * 外し忘れでチケットが再浮上しないための保険)、盤面で done のカードが健全性だけ
 * 「確認待ちが放置されている」と言い出すのは矛盾になる。
 */
function checkStalePendingDecision(
  ticket: Ticket,
  now: Date,
  thresholds: HygieneThresholds,
  pendingDecisionIds: ReadonlySet<TicketId> | undefined,
): HygieneIssue | null {
  if (pendingDecisionIds === undefined || !pendingDecisionIds.has(ticket.id)) {
    return null;
  }
  if (ticket.status === 'closed') {
    return null;
  }
  if (!isValidDate(ticket.updatedAt)) {
    return null;
  }

  const elapsedMs = now.getTime() - ticket.updatedAt.getTime();
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
  const issueDiff = a.issueId.localeCompare(b.issueId);
  if (issueDiff !== 0) {
    return issueDiff;
  }
  return a.dependsOnId.localeCompare(b.dependsOnId);
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

  let indexCounter = 0;
  const indices = new Map<TicketId, number>();
  const lowlink = new Map<TicketId, number>();
  const onStack = new Set<TicketId>();
  const tarjanStack: TicketId[] = [];
  const sccMembers: TicketId[][] = [];

  function strongConnect(v: TicketId): void {
    indices.set(v, indexCounter);
    lowlink.set(v, indexCounter);
    indexCounter += 1;
    tarjanStack.push(v);
    onStack.add(v);

    for (const w of neighbors(v)) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: TicketId[] = [];
      let w: TicketId;
      do {
        w = tarjanStack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      sccMembers.push(component);
    }
  }

  for (const ticket of tickets) {
    if (!indices.has(ticket.id)) {
      strongConnect(ticket.id);
    }
  }

  const cycles: DependencyCycle[] = [];

  for (const component of sccMembers) {
    if (component.length < 2) {
      continue;
    }

    const ticketIds = [...component].sort((a, b) => a.localeCompare(b));
    const memberSet = new Set(ticketIds);
    const edges = collectCycleEdges(tickets, memberSet);
    cycles.push({ ticketIds, edges });
  }

  return cycles.sort((a, b) => a.ticketIds[0]!.localeCompare(b.ticketIds[0]!));
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
  const projectDiff = a.projectId.localeCompare(b.projectId);
  if (projectDiff !== 0) {
    return projectDiff;
  }
  return a.ticketId.localeCompare(b.ticketId);
}

export function checkHygiene(
  tickets: readonly Ticket[],
  ctx: {
    readonly now: Date;
    readonly thresholds?: HygieneThresholds;
    readonly leftoverCandidates?: readonly LeftoverCandidate[];
    /**
     * 確認待ち(awaiting_human)のチケットID。bd の human ラベル由来で Ticket からは
     * 判定できないため、呼び出し側が集めて渡す。未指定なら
     * stale_pending_decision は一切出ない。
     */
    readonly pendingDecisionIds?: ReadonlySet<TicketId>;
  },
): readonly HygieneIssue[] {
  const thresholds = ctx.thresholds ?? DEFAULT_HYGIENE_THRESHOLDS;
  const readiness = createReadinessContext(tickets);
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const childrenIndex = buildDirectChildrenIndex(tickets);
  const issues: HygieneIssue[] = [];

  for (const ticket of tickets) {
    const overdueDefer = checkOverdueDefer(ticket, ctx.now);
    if (overdueDefer !== null) {
      issues.push(overdueDefer);
    }

    const staleEpic = checkStaleEpic(ticket, childrenIndex, ticketById);
    if (staleEpic !== null) {
      issues.push(staleEpic);
    }

    const staleInProgress = checkStaleInProgress(ticket, ctx.now, thresholds);
    if (staleInProgress !== null) {
      issues.push(staleInProgress);
    }

    const stalePendingDecision = checkStalePendingDecision(
      ticket,
      ctx.now,
      thresholds,
      ctx.pendingDecisionIds,
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
