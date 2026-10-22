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
import { orderByLaneDependencies } from './dependency-order.js';
import { computeEffectivePriorities } from './effective-priority.js';
import { buildLanes } from './lanes.js';
import type { Board, BoardCard, BuildBoardInput } from './types.js';

export function buildBoard(input: BuildBoardInput): Board {
  const ctx = createReadinessContext(input.tickets);
  const blocksIndex = buildBlocksIndex(input.tickets);
  const childrenIndex = buildDirectChildrenIndex(input.tickets);
  const ticketById = new Map(
    input.tickets.map((ticket) => [ticket.id, ticket] as const),
  );
  const effectivePriorities = computeEffectivePriorities(
    input.tickets,
    blocksIndex,
  );

  const cards: BoardCard[] = input.tickets.map((ticket) => {
    const blocks = deriveBlocks(ticket.id, blocksIndex, ctx);

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
      blockedBy: openBlockerIds(ticket, ctx),
      blocks,
      unblocksCount: blocks.length,
      stalled: isStalled(ticket, {
        now: input.now,
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
  const ordered = orderByLaneDependencies(cards);

  return {
    cards: ordered,
    lanes: buildLanes(ordered),
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
  const ordered = orderByLaneDependencies(cards);

  return {
    cards: ordered,
    lanes: buildLanes(ordered),
  };
}
