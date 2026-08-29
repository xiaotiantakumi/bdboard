import { getBoardTimeZone } from '../../config/board-timezone.js';
import { KNOWN_STAGE_ORDER } from '../../domain/ticket-model.js';
import type { Ticket } from '../../domain/ticket.js';
import type { BoardCache } from '../ports/board-cache.js';
import {
  buildWeekStarts,
  isInWeek,
  isInWeekRange,
} from './week-boundary.js';

export interface WeeklyModelCloseCounts {
  readonly weekStart: Date;
  /** モデル名 → その週にクローズされたチケット数 */
  readonly counts: Readonly<Record<string, number>>;
}

export interface StageModelCounts {
  readonly stage: string;
  /** モデル名 → そのstageでそのモデルが使われてクローズされたチケット数 */
  readonly counts: Readonly<Record<string, number>>;
}

export interface ModelStats {
  readonly weeklyCloses: readonly WeeklyModelCloseCounts[];
  readonly stageModelDistribution: readonly StageModelCounts[];
}

export interface GetModelStatsOptions {
  readonly projectIds?: readonly string[];
  readonly weeks?: number;
  readonly timeZone?: string;
}

const DEFAULT_WEEKS = 8;

function createEmptyWeeklyModelCloses(
  weekStarts: readonly Date[],
): WeeklyModelCloseCounts[] {
  return weekStarts.map((weekStart) => ({ weekStart, counts: {} }));
}

function uniqueModelsFromTicket(ticket: Ticket): readonly string[] {
  const models = ticket.models ?? [];
  if (models.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const record of models) {
    if (!seen.has(record.model)) {
      seen.add(record.model);
      unique.push(record.model);
    }
  }
  return unique;
}

function countWeeklyModelCloses(
  tickets: readonly Ticket[],
  weekStarts: readonly Date[],
): WeeklyModelCloseCounts[] {
  const buckets = createEmptyWeeklyModelCloses(weekStarts);

  for (const ticket of tickets) {
    if (ticket.closedAt === undefined) {
      continue;
    }
    if (!isInWeekRange(ticket.closedAt, weekStarts)) {
      continue;
    }

    const modelNames = uniqueModelsFromTicket(ticket);
    if (modelNames.length === 0) {
      continue;
    }

    for (let index = 0; index < weekStarts.length; index += 1) {
      const weekStart = weekStarts[index];
      if (weekStart !== undefined && isInWeek(ticket.closedAt, weekStart)) {
        const bucket = buckets[index];
        if (bucket !== undefined) {
          const counts = { ...bucket.counts };
          for (const modelName of modelNames) {
            counts[modelName] = (counts[modelName] ?? 0) + 1;
          }
          buckets[index] = { weekStart, counts };
        }
        break;
      }
    }
  }

  return buckets;
}

function sortStages(stages: readonly string[]): string[] {
  const knownOrder = new Map<string, number>(
    KNOWN_STAGE_ORDER.map((stage, index) => [stage, index]),
  );

  return [...stages].sort((a, b) => {
    const aKnown = knownOrder.get(a);
    const bKnown = knownOrder.get(b);

    if (aKnown !== undefined && bKnown !== undefined) {
      return aKnown - bKnown;
    }
    if (aKnown !== undefined) {
      return -1;
    }
    if (bKnown !== undefined) {
      return 1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function countStageModelDistribution(
  tickets: readonly Ticket[],
): StageModelCounts[] {
  const stageCounts = new Map<string, Record<string, number>>();

  for (const ticket of tickets) {
    if (ticket.closedAt === undefined) {
      continue;
    }

    const models = ticket.models ?? [];
    for (const record of models) {
      const existing = stageCounts.get(record.stage) ?? {};
      existing[record.model] = (existing[record.model] ?? 0) + 1;
      stageCounts.set(record.stage, existing);
    }
  }

  return sortStages([...stageCounts.keys()]).map((stage) => ({
    stage,
    counts: stageCounts.get(stage) ?? {},
  }));
}

function collectTickets(cache: BoardCache, projectIdFilter?: readonly string[]): Ticket[] {
  let entries = cache.listProjects();
  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const tickets: Ticket[] = [];
  for (const entry of entries) {
    tickets.push(...entry.tickets);
  }
  return tickets;
}

export function getModelStats(
  cache: BoardCache,
  now: Date,
  options?: GetModelStatsOptions,
): ModelStats {
  const weeks = Math.max(1, options?.weeks ?? DEFAULT_WEEKS);
  const timeZone = options?.timeZone ?? getBoardTimeZone();
  const weekStarts = buildWeekStarts(now, weeks, timeZone);
  const tickets = collectTickets(cache, options?.projectIds);

  return {
    weeklyCloses: countWeeklyModelCloses(tickets, weekStarts),
    stageModelDistribution: countStageModelDistribution(tickets),
  };
}
