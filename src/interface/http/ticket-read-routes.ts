import { Hono } from 'hono';
import { parseClampedIntQueryParam } from './parse-clamped-int-query-param.js';
import { getTicketTimeline } from '../../application/board/get-ticket-timeline.js';
import { getSimilarTickets } from '../../application/board/find-similar-tickets.js';
import { getBoard } from '../../application/board/get-board.js';
import { scanGitLeftovers } from '../../application/board/scan-git-leftovers.js';
import { scanInFlightOverlaps } from '../../application/board/scan-in-flight-overlaps.js';
import {
  overlapPeersForTicket,
  selectInFlightWorktrees,
  type InFlightOverlap,
} from '../../domain/in-flight-overlap.js';
import { buildDirectChildrenIndex } from '../../domain/epic-progress.js';
import {
  getTicketTokenUsage,
  hasTicketTokenUsage,
} from '../../application/board/get-ticket-token-usage.js';
import {
  toActivityEventDto,
  toTicketDetailDto,
  toTicketInFlightOverlapDto,
  toTicketSimilarResultDto,
  toTicketTokenUsageDto,
  type TicketChildDto,
} from './dto.js';
import {
  buildGetBoardDeps,
  parseActivityLimit,
  type InFlightOverlapMemo,
} from './api-route-shared.js';
import type { ApiDeps } from './api-deps.js';

const SIMILAR_DEFAULT_LIMIT = 5;
const SIMILAR_MIN_LIMIT = 1;
const SIMILAR_MAX_LIMIT = 20;

export interface PendingDecisionDto {
  readonly id: string;
  readonly projectId: string;
  readonly kind: 'gate' | 'ticket';
  readonly question?: string;
  readonly options?: readonly { readonly label: string; readonly value: string }[];
  readonly allowFreeform: boolean;
}

function parseSimilarLimit(raw: string | undefined): number {
  return parseClampedIntQueryParam(raw, {
    min: SIMILAR_MIN_LIMIT,
    max: SIMILAR_MAX_LIMIT,
    defaultValue: SIMILAR_DEFAULT_LIMIT,
  });
}

export function createTicketReadRoutes(deps: ApiDeps, memo: InFlightOverlapMemo): Hono {
  const app = new Hono();
  const { peekInFlightOverlaps, memoizedInFlightOverlaps } = memo;

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
          kind: decision.kind,
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

  // 着手中チケット同士のファイル重複の、1 チケットぶん (詳細パネル用)。
  // 対象チケットが属するプロジェクトの worktree だけを読む。
  app.get('/api/tickets/:id/in-flight-overlaps', async (c) => {
    const id = c.req.param('id');
    if (deps.worktreeScanner === undefined) {
      return c.json([]);
    }

    const entry = deps.cache
      .listProjects()
      .find((candidate) => candidate.tickets.some((ticket) => ticket.id === id));
    if (entry === undefined) {
      return c.json([]);
    }

    // git を 1 本も叩く前に打ち切れるケースを先に落とす。詳細パネルは着手中でない
    // チケットでも開くので、ここが効く割合は高い。
    const ticket = entry.tickets.find((candidate) => candidate.id === id);
    if (ticket === undefined || ticket.status === 'closed') {
      return c.json([]);
    }

    const scanner = deps.worktreeScanner;
    const projectEntries = [entry];

    const memoized = peekInFlightOverlaps(projectEntries);
    let overlaps: readonly InFlightOverlap[];
    if (memoized !== undefined) {
      overlaps = await memoized;
    } else {
      // git worktree list までは走らせる (1 回で済む安い呼び出し) が、変更ファイルを
      // 読むのはこのチケット自身に worktree があるときだけ。詳細パネルは worktree の
      // 無いチケットでも開くので、ここで大半が落ちる。
      const { candidates: leftovers } = await scanGitLeftovers([entry.project], scanner);
      const inFlight = selectInFlightWorktrees(leftovers, entry.tickets);
      if (!inFlight.some((worktree) => worktree.ticketId === id)) {
        return c.json([]);
      }
      overlaps = await memoizedInFlightOverlaps(projectEntries, () =>
        scanInFlightOverlaps(inFlight, scanner),
      );
    }

    return c.json(
      overlapPeersForTicket(overlaps, entry.project.id, id).map(
        toTicketInFlightOverlapDto,
      ),
    );
  });

  app.get('/api/tickets/:id{.+}', async (c) => {
    const id = c.req.param('id');
    const links = deps.links?.();
    const view = await getBoard(await buildGetBoardDeps(deps), { mode: 'merged' });

    const card = view.merged?.cards.find((entry) => entry.ticket.id === id);
    if (card === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

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

    const detail = toTicketDetailDto(card, card.ticket.models ?? [], children);
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

  return app;
}
