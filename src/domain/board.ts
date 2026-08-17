import { compareStrings } from './compare.js';
import { daysUntilDefer, deriveDeferUrgency, type DeferUrgency } from './defer.js';
import {
  buildDirectChildrenIndex,
  epicProgressFromIndex,
  type EpicProgress,
} from './epic-progress.js';
import type { Liveness, LivenessThresholds } from './liveness.js';
import { computeLiveness, livenessRank } from './liveness.js';
import {
  createReadinessContext,
  deriveLane,
  openBlockerIds,
  type Lane,
  type ReadinessContext,
} from './readiness.js';
import type { AgentSession, SessionLink } from './session.js';
import { isStalled, type StalledThresholds } from './stalled.js';
import type { Priority } from './status.js';
import type { Ticket } from './ticket.js';
import type { TicketId } from './ticket-id.js';

export interface BoardCard {
  readonly ticket: Ticket;
  readonly lane: Lane;
  readonly projectId: string;
  readonly sessions: readonly AgentSession[];
  readonly liveness: Liveness | null;
  readonly blockedBy: readonly TicketId[];
  readonly blocks: readonly TicketId[];
  readonly unblocksCount: number;
  readonly stalled: boolean;
  readonly epicProgress: EpicProgress | null;
  readonly deferDays: number | null;
  readonly deferUrgency: DeferUrgency | null;
  readonly effectivePriority: Priority;
  readonly priorityInheritedFrom: TicketId | null;
}

export interface Board {
  readonly cards: readonly BoardCard[];
  readonly lanes: Readonly<Record<Lane, readonly BoardCard[]>>;
}

export interface BuildBoardInput {
  readonly projectId: string;
  readonly tickets: readonly Ticket[];
  readonly now: Date;
  readonly sessions?: readonly AgentSession[];
  readonly links?: readonly SessionLink[];
  readonly livenessThresholds?: LivenessThresholds;
  readonly stalledThresholds?: StalledThresholds;
  /** bd の human ラベルが付いたチケットID集合。指定分は awaiting_human レーンへ振り分ける */
  readonly humanLabeledIds?: ReadonlySet<TicketId>;
}

function buildBlocksIndex(
  tickets: readonly Ticket[],
): Map<TicketId, TicketId[]> {
  const index = new Map<TicketId, TicketId[]>();

  for (const ticket of tickets) {
    for (const edge of ticket.dependencies) {
      if (edge.kind !== 'blocks') {
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

interface SuccessorMinResult {
  minPriority: Priority | null;
  inheritedFrom: TicketId | null;
}

interface EffectivePriorityResult {
  effectivePriority: Priority;
  priorityInheritedFrom: TicketId | null;
}

function mergeSuccessorCandidate(
  result: SuccessorMinResult,
  id: TicketId,
  priority: Priority,
): void {
  if (result.minPriority === null || priority < result.minPriority) {
    result.minPriority = priority;
    result.inheritedFrom = id;
    return;
  }

  if (
    priority === result.minPriority &&
    result.inheritedFrom !== null &&
    compareStrings(id, result.inheritedFrom) < 0
  ) {
    result.inheritedFrom = id;
  }
}

function computeEffectivePriorities(
  tickets: readonly Ticket[],
  blocksIndex: Map<TicketId, TicketId[]>,
): Map<TicketId, EffectivePriorityResult> {
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));

  function isEligibleSuccessor(id: TicketId): boolean {
    const ticket = ticketById.get(id);
    return ticket !== undefined && ticket.status !== 'closed';
  }

  function neighbors(id: TicketId): readonly TicketId[] {
    return (blocksIndex.get(id) ?? []).filter(isEligibleSuccessor);
  }

  let indexCounter = 0;
  const indices = new Map<TicketId, number>();
  const lowlink = new Map<TicketId, number>();
  const onStack = new Set<TicketId>();
  const tarjanStack: TicketId[] = [];
  const sccOf = new Map<TicketId, number>();
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
        sccOf.set(w, sccMembers.length);
      } while (w !== v);
      sccMembers.push(component);
    }
  }

  for (const ticket of tickets) {
    if (!indices.has(ticket.id)) {
      strongConnect(ticket.id);
    }
  }

  const sccResultMemo = new Map<number, SuccessorMinResult>();

  function sccOwnMin(componentIndex: number): SuccessorMinResult {
    const result: SuccessorMinResult = { minPriority: null, inheritedFrom: null };
    for (const memberId of sccMembers[componentIndex]) {
      if (isEligibleSuccessor(memberId)) {
        mergeSuccessorCandidate(result, memberId, ticketById.get(memberId)!.priority);
      }
    }
    return result;
  }

  function sccDownstreamMin(componentIndex: number): SuccessorMinResult {
    const memoized = sccResultMemo.get(componentIndex);
    if (memoized !== undefined) {
      return memoized;
    }

    const result = sccOwnMin(componentIndex);

    for (const memberId of sccMembers[componentIndex]) {
      for (const succId of neighbors(memberId)) {
        const succComponent = sccOf.get(succId)!;
        if (succComponent === componentIndex) {
          continue;
        }
        const sub = sccDownstreamMin(succComponent);
        if (sub.minPriority !== null && sub.inheritedFrom !== null) {
          mergeSuccessorCandidate(result, sub.inheritedFrom, sub.minPriority);
        }
      }
    }

    sccResultMemo.set(componentIndex, result);
    return result;
  }

  const results = new Map<TicketId, EffectivePriorityResult>();
  for (const ticket of tickets) {
    const componentIndex = sccOf.get(ticket.id)!;
    const successorMin = sccDownstreamMin(componentIndex);
    const effectivePriority =
      successorMin.minPriority === null
        ? ticket.priority
        : (Math.min(ticket.priority, successorMin.minPriority) as Priority);
    const priorityInheritedFrom =
      successorMin.minPriority !== null && successorMin.minPriority < ticket.priority
        ? successorMin.inheritedFrom
        : null;

    results.set(ticket.id, { effectivePriority, priorityInheritedFrom });
  }

  return results;
}

function buildSessionIdsByTicket(
  links: readonly SessionLink[],
): Map<TicketId, string[]> {
  const index = new Map<TicketId, string[]>();

  for (const link of links) {
    let sessionIds = index.get(link.ticketId);
    if (sessionIds === undefined) {
      sessionIds = [];
      index.set(link.ticketId, sessionIds);
    }
    sessionIds.push(link.sessionId);
  }

  return index;
}

function deriveBlocks(
  ticketId: TicketId,
  blocksIndex: Map<TicketId, TicketId[]>,
  ctx: ReadinessContext,
): readonly TicketId[] {
  const candidates = blocksIndex.get(ticketId) ?? [];
  const seen = new Set<TicketId>();
  const blocks: TicketId[] = [];

  for (const issueId of candidates) {
    const status = ctx.statusOf(issueId);
    if (status === undefined || status === 'closed') {
      continue;
    }

    if (!seen.has(issueId)) {
      seen.add(issueId);
      blocks.push(issueId);
    }
  }

  return blocks.sort(compareStrings);
}

function deriveSessions(
  ticketId: TicketId,
  sessionById: ReadonlyMap<string, AgentSession>,
  sessionIdsByTicket: ReadonlyMap<TicketId, string[]>,
): readonly AgentSession[] {
  const sessionIds = [...(sessionIdsByTicket.get(ticketId) ?? [])].sort(
    compareStrings,
  );

  const seen = new Set<string>();
  const linked: AgentSession[] = [];

  for (const sessionId of sessionIds) {
    if (seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);

    const session = sessionById.get(sessionId);
    if (session !== undefined) {
      linked.push(session);
    }
  }

  return linked;
}

function deriveLiveness(
  now: Date,
  sessions: readonly AgentSession[],
  thresholds?: LivenessThresholds,
): Liveness | null {
  if (sessions.length === 0) {
    return null;
  }

  let best: Liveness | null = null;
  let bestRank = Number.POSITIVE_INFINITY;

  for (const session of sessions) {
    const liveness = computeLiveness(now, session, thresholds);
    const rank = livenessRank(liveness);
    if (rank < bestRank) {
      bestRank = rank;
      best = liveness;
    }
  }

  return best;
}

function buildLanes(cards: readonly BoardCard[]): Board['lanes'] {
  const lanes: Record<Lane, BoardCard[]> = {
    ready: [],
    in_progress: [],
    awaiting_human: [],
    blocked: [],
    done: [],
  };

  for (const card of cards) {
    lanes[card.lane].push(card);
  }

  // bdboard-662: 保留(deferred)はブロックへ表示統合された。統合後の blocked レーンは
  // 依存関係でブロックされているチケットと保留チケットが混在するため、他のレーンと同様
  // compareCards(優先度ベース)の順序をそのまま使う。保留固有の「締切が近い順」ソートは
  // 廃止した(deferDays/deferUrgency のカード表示自体は buildBoard 側で維持している)。

  return lanes;
}

export function compareCards(a: BoardCard, b: BoardCard): number {
  const effectiveDiff = a.effectivePriority - b.effectivePriority;
  if (effectiveDiff !== 0) {
    return effectiveDiff;
  }

  const priorityDiff = a.ticket.priority - b.ticket.priority;
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  const aLivenessRank = a.liveness === null ? 4 : livenessRank(a.liveness);
  const bLivenessRank = b.liveness === null ? 4 : livenessRank(b.liveness);
  if (aLivenessRank !== bLivenessRank) {
    return aLivenessRank - bLivenessRank;
  }

  if (a.unblocksCount !== b.unblocksCount) {
    return b.unblocksCount - a.unblocksCount;
  }

  const updatedDiff = b.ticket.updatedAt.getTime() - a.ticket.updatedAt.getTime();
  if (updatedDiff !== 0) {
    return updatedDiff;
  }

  const idDiff = compareStrings(a.ticket.id, b.ticket.id);
  if (idDiff !== 0) {
    return idDiff;
  }

  return compareStrings(a.projectId, b.projectId);
}

export function buildBoard(input: BuildBoardInput): Board {
  const ctx = createReadinessContext(input.tickets);
  const sessions = input.sessions ?? [];
  const links = input.links ?? [];
  const blocksIndex = buildBlocksIndex(input.tickets);
  const childrenIndex = buildDirectChildrenIndex(input.tickets);
  const ticketById = new Map(
    input.tickets.map((ticket) => [ticket.id, ticket] as const),
  );
  const sessionById = new Map(
    sessions.map((session) => [session.sessionId, session] as const),
  );
  const sessionIdsByTicket = buildSessionIdsByTicket(links);
  const effectivePriorities = computeEffectivePriorities(
    input.tickets,
    blocksIndex,
  );

  const cards: BoardCard[] = input.tickets.map((ticket) => {
    const ticketSessions = deriveSessions(
      ticket.id,
      sessionById,
      sessionIdsByTicket,
    );
    const blocks = deriveBlocks(ticket.id, blocksIndex, ctx);
    // 紐付いていても死んでいるセッションはまさに滞留の兆候
    const hasActiveSession = ticketSessions.some((session) => session.alive);

    const deferUntil = ticket.deferUntil;
    const deferDays =
      deferUntil !== undefined
        ? daysUntilDefer(deferUntil, input.now)
        : null;
    const deferUrgency =
      deferUntil !== undefined
        ? deriveDeferUrgency(deferUntil, input.now)
        : null;

    const effective = effectivePriorities.get(ticket.id)!;

    return {
      ticket,
      lane: deriveLane(ticket, ctx, input.now, input.humanLabeledIds),
      projectId: input.projectId,
      sessions: ticketSessions,
      liveness: deriveLiveness(
        input.now,
        ticketSessions,
        input.livenessThresholds,
      ),
      blockedBy: openBlockerIds(ticket, ctx),
      blocks,
      unblocksCount: blocks.length,
      stalled: isStalled(ticket, {
        now: input.now,
        hasActiveSession,
        ...(input.stalledThresholds !== undefined
          ? { thresholds: input.stalledThresholds }
          : {}),
      }),
      epicProgress: epicProgressFromIndex(
        ticket.id,
        childrenIndex,
        ticketById,
      ),
      deferDays,
      deferUrgency,
      effectivePriority: effective.effectivePriority,
      priorityInheritedFrom: effective.priorityInheritedFrom,
    };
  });

  cards.sort(compareCards);

  return {
    cards,
    lanes: buildLanes(cards),
  };
}

export function mergeBoards(boards: readonly Board[]): Board {
  const seen = new Set<string>();
  const cards: BoardCard[] = [];

  for (const board of boards) {
    for (const card of board.cards) {
      const key = `${card.projectId} ${card.ticket.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      cards.push(card);
    }
  }

  cards.sort(compareCards);

  return {
    cards,
    lanes: buildLanes(cards),
  };
}
