import { daysUntilDefer, deriveDeferUrgency } from '../defer.js';
import {
  buildDirectChildrenIndex,
  epicProgressFromIndex,
} from '../epic-progress.js';
import {
  createReadinessContext,
  deriveLane,
  openBlockerIds,
} from '../readiness.js';
import { isStalled } from '../stalled.js';
import { buildBlocksIndex, deriveBlocks } from './blocks.js';
import { compareCards } from './card-compare.js';
import { computeEffectivePriorities } from './effective-priority.js';
import { buildLanes } from './lanes.js';
import { buildSessionIdsByTicket, deriveLiveness, deriveSessions } from './sessions.js';
import type { Board, BoardCard, BuildBoardInput } from './types.js';

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
        ? daysUntilDefer(deferUntil, input.now, input.timeZone)
        : null;
    const deferUrgency =
      deferUntil !== undefined
        ? deriveDeferUrgency(deferUntil, input.now, input.timeZone)
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
