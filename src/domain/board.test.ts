import { describe, expect, it } from 'vitest';
import type { DependencyEdge } from './dependency.js';
import {
  buildBoard,
  compareCards,
  mergeBoards,
  type BoardCard,
} from './board.js';
import { LANES } from './readiness.js';
import { makeSession, makeSessionLink, makeTicket } from './test-support.js';
import type { Ticket } from './ticket.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const BASE = new Date('2026-01-01T00:00:00.000Z');
const NEWER = new Date('2026-06-01T00:00:00.000Z');
const OLDER = new Date('2026-01-01T00:00:00.000Z');
const PROJECT = '/projects/bdboard';

function blocksEdge(issueId: string, dependsOnId: string): DependencyEdge {
  return { issueId, dependsOnId, kind: 'blocks' };
}

function makeCard(
  ticket: Ticket,
  overrides: Partial<Omit<BoardCard, 'ticket'>> = {},
): BoardCard {
  return {
    lane: 'ready',
    projectId: PROJECT,
    sessions: [],
    liveness: null,
    blockedBy: [],
    blocks: [],
    unblocksCount: 0,
    stalled: false,
    epicProgress: null,
    deferDays: null,
    deferUrgency: null,
    effectivePriority: ticket.priority,
    priorityInheritedFrom: null,
    ticket,
    ...overrides,
  };
}

function cardIds(board: { cards: readonly BoardCard[] }): string[] {
  return board.cards.map((c) => c.ticket.id);
}

describe('compareCards', () => {
  it('sorts by effectivePriority ascending when only effectivePriority differs', () => {
    const shared = {
      priority: 3 as const,
      updatedAt: BASE,
      id: 'bdboard-sort',
    };
    const high = makeCard(makeTicket({ ...shared, priority: 3 }), {
      effectivePriority: 0,
    });
    const low = makeCard(makeTicket({ ...shared, priority: 3 }), {
      effectivePriority: 1,
    });
    expect(compareCards(high, low)).toBeLessThan(0);
    expect(compareCards(low, high)).toBeGreaterThan(0);
  });

  it('sorts by priority ascending when only priority differs', () => {
    const shared = {
      priority: 2 as const,
      updatedAt: BASE,
      id: 'bdboard-sort',
    };
    const high = makeCard(makeTicket({ ...shared, priority: 0 }));
    const low = makeCard(makeTicket({ ...shared, priority: 1 }));
    expect(compareCards(high, low)).toBeLessThan(0);
    expect(compareCards(low, high)).toBeGreaterThan(0);
  });

  it('sorts by liveness rank ascending when only liveness differs (null is last)', () => {
    const ticket = makeTicket({
      id: 'bdboard-live',
      priority: 2,
      updatedAt: BASE,
    });
    const active = makeCard(ticket, { liveness: 'active' });
    const idle = makeCard(ticket, { liveness: 'idle' });
    const stale = makeCard(ticket, { liveness: 'stale' });
    const dormant = makeCard(ticket, { liveness: 'dormant' });
    const none = makeCard(ticket, { liveness: null });

    expect(compareCards(active, idle)).toBeLessThan(0);
    expect(compareCards(idle, stale)).toBeLessThan(0);
    expect(compareCards(stale, dormant)).toBeLessThan(0);
    expect(compareCards(dormant, none)).toBeLessThan(0);
  });

  it('sorts by unblocksCount descending when only unblocksCount differs', () => {
    const ticket = makeTicket({
      id: 'bdboard-unblock',
      priority: 2,
      updatedAt: BASE,
    });
    const many = makeCard(ticket, { unblocksCount: 3, blocks: ['a', 'b', 'c'] });
    const few = makeCard(ticket, { unblocksCount: 1, blocks: ['a'] });
    expect(compareCards(many, few)).toBeLessThan(0);
    expect(compareCards(few, many)).toBeGreaterThan(0);
  });

  it('sorts by updatedAt descending when only updatedAt differs', () => {
    const newer = makeCard(
      makeTicket({ id: 'bdboard-date', priority: 2, updatedAt: NEWER }),
    );
    const older = makeCard(
      makeTicket({ id: 'bdboard-date', priority: 2, updatedAt: OLDER }),
    );
    expect(compareCards(newer, older)).toBeLessThan(0);
    expect(compareCards(older, newer)).toBeGreaterThan(0);
  });

  it('sorts by ticket id ascending when only id differs', () => {
    const a = makeCard(
      makeTicket({ id: 'bdboard-aaa', priority: 2, updatedAt: BASE }),
    );
    const b = makeCard(
      makeTicket({ id: 'bdboard-bbb', priority: 2, updatedAt: BASE }),
    );
    expect(compareCards(a, b)).toBeLessThan(0);
    expect(compareCards(b, a)).toBeGreaterThan(0);
  });

  it('sorts by projectId ascending when id is the same but projectId differs', () => {
    const ticket = makeTicket({ id: 'bdboard-dup', priority: 2, updatedAt: BASE });
    const projA = makeCard(ticket, { projectId: '/projects/a' });
    const projB = makeCard(ticket, { projectId: '/projects/b' });
    expect(compareCards(projA, projB)).toBeLessThan(0);
    expect(compareCards(projB, projA)).toBeGreaterThan(0);
  });

  it('sorts by ticket id using code-point order (not localeCompare)', () => {
    // localeCompare would put 'bdboard-a' before 'ExampleApp-a'; code-point order is the reverse.
    // makeCard defaults liveness to null and unblocksCount to 0, so only the id differs.
    const shared = { priority: 2 as const, updatedAt: BASE };
    const kakei = makeCard(makeTicket({ ...shared, id: 'ExampleApp-a' }));
    const bdboard = makeCard(makeTicket({ ...shared, id: 'bdboard-a' }));
    expect(compareCards(kakei, bdboard)).toBeLessThan(0);
    expect(compareCards(bdboard, kakei)).toBeGreaterThan(0);
  });
});

describe('buildBoard blocks and unblocksCount', () => {
  it('derives blocks via reverse lookup and excludes closed successors', () => {
    const blocker = makeTicket({
      id: 'bdboard-blocker',
      status: 'open',
      dependencies: [],
    });
    const openSuccessor = makeTicket({
      id: 'bdboard-open',
      status: 'open',
      dependencies: [blocksEdge('bdboard-open', 'bdboard-blocker')],
    });
    const closedSuccessor = makeTicket({
      id: 'bdboard-closed',
      status: 'closed',
      dependencies: [blocksEdge('bdboard-closed', 'bdboard-blocker')],
    });
    const ghostEdgeHolder = makeTicket({
      id: 'bdboard-holder',
      status: 'open',
      dependencies: [blocksEdge('bdboard-ghost', 'bdboard-blocker')],
    });
    const tickets = [blocker, openSuccessor, closedSuccessor, ghostEdgeHolder];

    const board = buildBoard({
      projectId: PROJECT,
      tickets,
      now: NOW,
    });

    const card = board.cards.find((c) => c.ticket.id === 'bdboard-blocker');
    expect(card).toBeDefined();
    expect(card!.blocks).toEqual(['bdboard-open']);
    expect(card!.unblocksCount).toBe(1);
  });

  it('sorts blocks ids ascending and deduplicates', () => {
    const blocker = makeTicket({
      id: 'bdboard-hub',
      status: 'open',
      dependencies: [],
    });
    const succB = makeTicket({
      id: 'bdboard-b',
      status: 'open',
      dependencies: [
        blocksEdge('bdboard-b', 'bdboard-hub'),
        blocksEdge('bdboard-b', 'bdboard-hub'),
      ],
    });
    const succA = makeTicket({
      id: 'bdboard-a',
      status: 'in_progress',
      dependencies: [blocksEdge('bdboard-a', 'bdboard-hub')],
    });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [blocker, succB, succA],
      now: NOW,
    });

    const card = board.cards.find((c) => c.ticket.id === 'bdboard-hub');
    expect(card!.blocks).toEqual(['bdboard-a', 'bdboard-b']);
    expect(card!.unblocksCount).toBe(2);
  });
});

describe('buildBoard sessions', () => {
  it('links sessions via links, ignores missing sessionIds, sorts by sessionId', () => {
    const ticket = makeTicket({ id: 'bdboard-linked' });
    const sessionZ = makeSession({ sessionId: 'session-z' });
    const sessionA = makeSession({ sessionId: 'session-a' });
    const links = [
      makeSessionLink({ ticketId: 'bdboard-linked', sessionId: 'session-z' }),
      makeSessionLink({ ticketId: 'bdboard-linked', sessionId: 'session-a' }),
      makeSessionLink({ ticketId: 'bdboard-linked', sessionId: 'session-missing' }),
      makeSessionLink({ ticketId: 'bdboard-other', sessionId: 'session-a' }),
      makeSessionLink({ ticketId: 'bdboard-linked', sessionId: 'session-a' }),
    ];

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [ticket],
      now: NOW,
      sessions: [sessionZ, sessionA],
      links,
    });

    const card = board.cards[0];
    expect(card.sessions.map((s) => s.sessionId)).toEqual([
      'session-a',
      'session-z',
    ]);
  });
});

describe('buildBoard liveness', () => {
  const thresholds = {
    activeMs: 60_000,
    idleMs: 120_000,
    staleMs: 180_000,
  };

  it('picks the most alive session liveness', () => {
    const ticket = makeTicket({ id: 'bdboard-live-pick' });
    const activeSession = makeSession({
      sessionId: 'session-active',
      lastActivityAt: NOW,
      alive: true,
    });
    const staleSession = makeSession({
      sessionId: 'session-stale',
      lastActivityAt: new Date(NOW.getTime() - 150_000),
      alive: true,
    });
    const links = [
      makeSessionLink({ ticketId: 'bdboard-live-pick', sessionId: 'session-stale' }),
      makeSessionLink({ ticketId: 'bdboard-live-pick', sessionId: 'session-active' }),
    ];

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [ticket],
      now: NOW,
      sessions: [activeSession, staleSession],
      links,
      livenessThresholds: thresholds,
    });

    expect(board.cards[0].liveness).toBe('active');
  });

  it('returns null liveness when no sessions are linked', () => {
    const ticket = makeTicket({ id: 'bdboard-no-session' });
    const board = buildBoard({
      projectId: PROJECT,
      tickets: [ticket],
      now: NOW,
    });
    expect(board.cards[0].liveness).toBeNull();
  });
});

describe('buildBoard lanes', () => {
  it('includes every LANES key with empty arrays when no cards match', () => {
    const board = buildBoard({
      projectId: PROJECT,
      tickets: [],
      now: NOW,
    });

    for (const lane of LANES) {
      expect(board.lanes[lane]).toEqual([]);
    }
  });

  it('distributes cards into lanes preserving cards order', () => {
    const ready = makeTicket({
      id: 'bdboard-ready',
      status: 'open',
      priority: 0,
    });
    const done = makeTicket({
      id: 'bdboard-done',
      status: 'closed',
      priority: 2,
    });
    const board = buildBoard({
      projectId: PROJECT,
      tickets: [done, ready],
      now: NOW,
    });

    expect(cardIds(board)).toEqual(['bdboard-ready', 'bdboard-done']);
    expect(board.lanes.ready.map((c) => c.ticket.id)).toEqual(['bdboard-ready']);
    expect(board.lanes.done.map((c) => c.ticket.id)).toEqual(['bdboard-done']);
    for (const lane of LANES) {
      expect(board.lanes[lane]).toBeDefined();
    }
  });

  it('puts a human-labeled ticket into awaiting_human and out of ready', () => {
    const waiting = makeTicket({ id: 'bdboard-waiting', status: 'open' });
    const plain = makeTicket({ id: 'bdboard-plain', status: 'open' });
    const board = buildBoard({
      projectId: PROJECT,
      tickets: [waiting, plain],
      now: NOW,
      humanLabeledIds: new Set(['bdboard-waiting']),
    });

    expect(board.lanes.awaiting_human.map((c) => c.ticket.id)).toEqual([
      'bdboard-waiting',
    ]);
    expect(board.lanes.ready.map((c) => c.ticket.id)).toEqual(['bdboard-plain']);
  });

  it('leaves awaiting_human empty when humanLabeledIds is not provided', () => {
    const plain = makeTicket({ id: 'bdboard-plain', status: 'open' });
    const board = buildBoard({
      projectId: PROJECT,
      tickets: [plain],
      now: NOW,
    });

    expect(board.lanes.awaiting_human).toEqual([]);
    expect(board.lanes.ready.map((c) => c.ticket.id)).toEqual(['bdboard-plain']);
  });

  it('leaves awaiting_human empty when humanLabeledIds is an empty set', () => {
    const plain = makeTicket({ id: 'bdboard-plain', status: 'open' });
    const board = buildBoard({
      projectId: PROJECT,
      tickets: [plain],
      now: NOW,
      humanLabeledIds: new Set(),
    });

    expect(board.lanes.awaiting_human).toEqual([]);
    expect(board.lanes.ready.map((c) => c.ticket.id)).toEqual(['bdboard-plain']);
  });
});

describe('buildBoard sorting', () => {
  it('returns cards sorted by compareCards', () => {
    const lowPrio = makeTicket({
      id: 'bdboard-low-prio',
      priority: 2,
      updatedAt: BASE,
    });
    const highPrio = makeTicket({
      id: 'bdboard-high-prio',
      priority: 0,
      updatedAt: BASE,
    });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [lowPrio, highPrio],
      now: NOW,
    });

    expect(cardIds(board)).toEqual(['bdboard-high-prio', 'bdboard-low-prio']);
  });
});

describe('buildBoard stalled', () => {
  const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60_000;
  const stalledUpdatedAt = new Date(NOW.getTime() - FORTY_EIGHT_HOURS_MS);

  it('marks stalled in_progress tickets without active sessions and old updatedAt', () => {
    const stalledTicket = makeTicket({
      id: 'bdboard-stalled',
      status: 'in_progress',
      updatedAt: stalledUpdatedAt,
    });
    const freshTicket = makeTicket({
      id: 'bdboard-fresh',
      status: 'in_progress',
      updatedAt: NOW,
    });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [stalledTicket, freshTicket],
      now: NOW,
    });

    expect(board.cards.find((c) => c.ticket.id === 'bdboard-stalled')?.stalled).toBe(
      true,
    );
    expect(board.cards.find((c) => c.ticket.id === 'bdboard-fresh')?.stalled).toBe(
      false,
    );
  });

  it('does not mark stalled when an alive session is linked even if updatedAt is old', () => {
    const ticket = makeTicket({
      id: 'bdboard-active-session',
      status: 'in_progress',
      updatedAt: stalledUpdatedAt,
    });
    const aliveSession = makeSession({ sessionId: 'session-alive', alive: true });
    const deadSession = makeSession({ sessionId: 'session-dead', alive: false });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [ticket],
      now: NOW,
      sessions: [aliveSession, deadSession],
      links: [
        makeSessionLink({ ticketId: ticket.id, sessionId: 'session-alive' }),
        makeSessionLink({ ticketId: ticket.id, sessionId: 'session-dead' }),
      ],
    });

    expect(board.cards[0].stalled).toBe(false);
  });

  it('does not change compareCards order when stalled flag differs', () => {
    const shared = {
      priority: 2 as const,
      status: 'in_progress' as const,
      updatedAt: stalledUpdatedAt,
    };
    const tickets = [
      makeTicket({ ...shared, id: 'bdboard-a' }),
      makeTicket({ ...shared, id: 'bdboard-b' }),
      makeTicket({ ...shared, id: 'bdboard-c' }),
    ];

    const withoutStalled = buildBoard({
      projectId: PROJECT,
      tickets,
      now: NOW,
      stalledThresholds: { stalledAfterMs: Number.POSITIVE_INFINITY },
    });
    const withStalled = buildBoard({
      projectId: PROJECT,
      tickets,
      now: NOW,
      stalledThresholds: { stalledAfterMs: 0 },
    });

    expect(cardIds(withoutStalled)).toEqual(cardIds(withStalled));
  });
});

describe('buildBoard epicProgress', () => {
  function parentChildEdge(issueId: string, dependsOnId: string): DependencyEdge {
    return { issueId, dependsOnId, kind: 'parent-child' };
  }

  it('sets epicProgress to null when the ticket has no direct children', () => {
    const leaf = makeTicket({ id: 'bdboard-leaf' });
    const board = buildBoard({
      projectId: PROJECT,
      tickets: [leaf],
      now: NOW,
    });

    expect(board.cards[0].epicProgress).toBeNull();
  });

  it('derives epicProgress from direct children only', () => {
    const epic = makeTicket({ id: 'bdboard-epic' });
    const doneChild = makeTicket({
      id: 'bdboard-done',
      parentId: 'bdboard-epic',
      status: 'closed',
    });
    const openChild = makeTicket({
      id: 'bdboard-open',
      dependencies: [parentChildEdge('bdboard-open', 'bdboard-epic')],
      status: 'open',
    });
    const grandchild = makeTicket({
      id: 'bdboard-grandchild',
      parentId: 'bdboard-open',
      status: 'closed',
    });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [epic, doneChild, openChild, grandchild],
      now: NOW,
    });

    const epicCard = board.cards.find((c) => c.ticket.id === 'bdboard-epic');
    expect(epicCard?.epicProgress).toEqual({ total: 2, done: 1 });
  });
});

describe('buildBoard defer fields and deferred lane sorting', () => {
  it('derives deferDays and deferUrgency from deferUntil', () => {
    const ticket = makeTicket({
      id: 'bdboard-defer',
      status: 'deferred',
      deferUntil: new Date('2026-06-08T00:00:00.000Z'),
    });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [ticket],
      now: NOW,
    });

    expect(board.cards[0].deferDays).toBe(7);
    expect(board.cards[0].deferUrgency).toBe('later');
  });

  it('uses timeZone for deferDays and deferUrgency when provided', () => {
    const ticket = makeTicket({
      id: 'bdboard-defer-tz',
      status: 'deferred',
      deferUntil: new Date('2026-06-08T00:00:00.000Z'),
    });
    const now = new Date('2026-06-01T15:00:00.000Z');

    const utcBoard = buildBoard({
      projectId: PROJECT,
      tickets: [ticket],
      now,
      timeZone: 'UTC',
    });
    const tokyoBoard = buildBoard({
      projectId: PROJECT,
      tickets: [ticket],
      now,
      timeZone: 'Asia/Tokyo',
    });

    expect(utcBoard.cards[0].deferDays).toBe(7);
    expect(tokyoBoard.cards[0].deferDays).toBe(6);
    expect(utcBoard.cards[0].deferUrgency).toBe('later');
    expect(tokyoBoard.cards[0].deferUrgency).toBe('later');
  });

  it('sets deferDays and deferUrgency to null when deferUntil is absent', () => {
    const ticket = makeTicket({
      id: 'bdboard-no-defer',
      status: 'open',
    });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [ticket],
      now: NOW,
    });

    expect(board.cards[0].deferDays).toBeNull();
    expect(board.cards[0].deferUrgency).toBeNull();
  });

  // bdboard-662: 保留(deferred)はブロック(blocked)へ表示統合された。以下は統合後の挙動:
  // (1) status='deferred' なチケットは lane==='blocked' に入る、(2) 依存関係で本当に
  // ブロックされているチケットと混在する、(3) 順序は他のレーンと同じ compareCards
  // (優先度ベース)に従う — 保留固有の「締切が近い順」ソートは廃止した、
  // (4) deferDays/deferUrgency は lane に関わらず deferUntil から計算され続けるので、
  // 「あと何日」表示の情報源は失われない。
  it('folds deferred-status tickets into the blocked lane, alongside dependency-blocked tickets', () => {
    const deferred = makeTicket({
      id: 'bdboard-deferred',
      status: 'deferred',
      priority: 3,
      updatedAt: BASE,
      deferUntil: new Date('2026-06-10T00:00:00.000Z'),
    });
    const dependencyBlocked = makeTicket({
      id: 'bdboard-dep-blocked',
      status: 'open',
      priority: 1,
      updatedAt: BASE,
      dependencies: [blocksEdge('bdboard-dep-blocked', 'bdboard-blocker')],
    });
    const blocker = makeTicket({
      id: 'bdboard-blocker',
      status: 'open',
      priority: 1,
      updatedAt: BASE,
    });
    const ready = makeTicket({
      id: 'bdboard-ready',
      status: 'open',
      priority: 2,
      updatedAt: BASE,
    });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [deferred, dependencyBlocked, blocker, ready],
      now: NOW,
    });

    // deferred と dependencyBlocked はどちらも blocked レーンに入る(deferred レーンは存在しない)。
    expect(new Set(board.lanes.blocked.map((c) => c.ticket.id))).toEqual(
      new Set(['bdboard-deferred', 'bdboard-dep-blocked']),
    );
    // blocked レーン内の順序は compareCards(優先度)に従う: priority 1 の dependencyBlocked が先。
    expect(board.lanes.blocked.map((c) => c.ticket.id)).toEqual([
      'bdboard-dep-blocked',
      'bdboard-deferred',
    ]);
    expect(new Set(board.lanes.ready.map((c) => c.ticket.id))).toEqual(
      new Set(['bdboard-ready', 'bdboard-blocker']),
    );
    // deferDays/deferUrgency は blocked レーンへ統合されても失われない。
    const deferredCard = board.cards.find((c) => c.ticket.id === 'bdboard-deferred')!;
    expect(deferredCard.lane).toBe('blocked');
    expect(deferredCard.deferDays).not.toBeNull();
    expect(deferredCard.deferUrgency).not.toBeNull();
    // 依存関係ブロックのカードには defer 情報が無い(混同しない)。
    const depBlockedCard = board.cards.find((c) => c.ticket.id === 'bdboard-dep-blocked')!;
    expect(depBlockedCard.deferDays).toBeNull();
    expect(depBlockedCard.deferUrgency).toBeNull();
  });
});

describe('mergeBoards', () => {
  function boardWithSingleCard(
    projectId: string,
    ticketOverrides: Parameters<typeof makeTicket>[0],
    cardOverrides: Partial<Omit<BoardCard, 'ticket'>> = {},
  ) {
    const ticket = makeTicket(ticketOverrides);
    const card = makeCard(ticket, { projectId, ...cardOverrides });
    const lanes = Object.fromEntries(
      LANES.map((lane) => [lane, lane === card.lane ? [card] : []]),
    ) as Record<(typeof LANES)[number], BoardCard[]>;
    return { cards: [card], lanes };
  }

  it('produces the same card order regardless of input board order', () => {
    const boardA = buildBoard({
      projectId: '/projects/a',
      tickets: [
        makeTicket({ id: 'bdboard-x', priority: 0, updatedAt: BASE }),
        makeTicket({ id: 'bdboard-y', priority: 1, updatedAt: BASE }),
      ],
      now: NOW,
    });
    const boardB = buildBoard({
      projectId: '/projects/b',
      tickets: [
        makeTicket({ id: 'bdboard-z', priority: 2, updatedAt: BASE }),
      ],
      now: NOW,
    });

    const forward = mergeBoards([boardA, boardB]);
    const reverse = mergeBoards([boardB, boardA]);

    expect(cardIds(forward)).toEqual(cardIds(reverse));
    expect(cardIds(forward)).toEqual(['bdboard-x', 'bdboard-y', 'bdboard-z']);
  });

  it('deduplicates by projectId and ticket id keeping the first occurrence', () => {
    const first = boardWithSingleCard(
      '/projects/a',
      { id: 'bdboard-dup', title: 'first' },
      { lane: 'ready' },
    );
    const second = boardWithSingleCard(
      '/projects/a',
      { id: 'bdboard-dup', title: 'second' },
      { lane: 'blocked' },
    );
    const other = boardWithSingleCard(
      '/projects/b',
      { id: 'bdboard-dup', title: 'other-project' },
      { lane: 'ready' },
    );

    const merged = mergeBoards([first, second, other]);

    expect(merged.cards).toHaveLength(2);
    expect(merged.cards[0].ticket.title).toBe('first');
    expect(merged.cards[1].ticket.title).toBe('other-project');
  });

  it('returns an empty board with all lane keys for empty input', () => {
    const merged = mergeBoards([]);
    expect(merged.cards).toEqual([]);
    for (const lane of LANES) {
      expect(merged.lanes[lane]).toEqual([]);
    }
  });

  it('rebuilds lanes with all LANES keys after merge', () => {
    const ready = boardWithSingleCard(
      PROJECT,
      { id: 'bdboard-r', status: 'open' },
      { lane: 'ready' },
    );
    const done = boardWithSingleCard(
      PROJECT,
      { id: 'bdboard-d', status: 'closed' },
      { lane: 'done' },
    );

    const merged = mergeBoards([ready, done]);

    for (const lane of LANES) {
      expect(merged.lanes[lane]).toBeDefined();
    }
    expect(merged.lanes.ready.map((c) => c.ticket.id)).toEqual(['bdboard-r']);
    expect(merged.lanes.done.map((c) => c.ticket.id)).toEqual(['bdboard-d']);
  });
});

describe('buildBoard effectivePriority', () => {
  it('inherits downstream priority so a P3 blocker sorts ahead in ready lane', () => {
    const blocker = makeTicket({
      id: 'bdboard-p3-blocker',
      status: 'open',
      priority: 3,
      dependencies: [],
    });
    const blocked = makeTicket({
      id: 'bdboard-p0-blocked',
      status: 'open',
      priority: 0,
      dependencies: [blocksEdge('bdboard-p0-blocked', 'bdboard-p3-blocker')],
    });
    const unrelated = makeTicket({
      id: 'bdboard-p1-unrelated',
      status: 'open',
      priority: 1,
      dependencies: [],
    });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [blocker, blocked, unrelated],
      now: NOW,
    });

    const blockerCard = board.cards.find(
      (c) => c.ticket.id === 'bdboard-p3-blocker',
    );
    expect(blockerCard?.effectivePriority).toBe(0);
    expect(blockerCard?.priorityInheritedFrom).toBe('bdboard-p0-blocked');
    expect(board.lanes.ready.map((c) => c.ticket.id)).toEqual([
      'bdboard-p3-blocker',
      'bdboard-p1-unrelated',
    ]);
  });

  it('propagates minimum priority through a three-ticket chain', () => {
    const top = makeTicket({
      id: 'bdboard-chain-a',
      status: 'open',
      priority: 4,
      dependencies: [],
    });
    const middle = makeTicket({
      id: 'bdboard-chain-b',
      status: 'open',
      priority: 2,
      dependencies: [blocksEdge('bdboard-chain-b', 'bdboard-chain-a')],
    });
    const bottom = makeTicket({
      id: 'bdboard-chain-c',
      status: 'open',
      priority: 0,
      dependencies: [blocksEdge('bdboard-chain-c', 'bdboard-chain-b')],
    });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [top, middle, bottom],
      now: NOW,
    });

    const topCard = board.cards.find((c) => c.ticket.id === 'bdboard-chain-a');
    const middleCard = board.cards.find((c) => c.ticket.id === 'bdboard-chain-b');
    expect(topCard?.effectivePriority).toBe(0);
    expect(topCard?.priorityInheritedFrom).toBe('bdboard-chain-c');
    expect(middleCard?.effectivePriority).toBe(0);
    expect(middleCard?.priorityInheritedFrom).toBe('bdboard-chain-c');
  });

  it('ignores closed downstream tickets when computing effectivePriority', () => {
    const blocker = makeTicket({
      id: 'bdboard-open-blocker',
      status: 'open',
      priority: 3,
      dependencies: [],
    });
    const closedDownstream = makeTicket({
      id: 'bdboard-closed-downstream',
      status: 'closed',
      priority: 0,
      dependencies: [blocksEdge('bdboard-closed-downstream', 'bdboard-open-blocker')],
    });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [blocker, closedDownstream],
      now: NOW,
    });

    const card = board.cards.find((c) => c.ticket.id === 'bdboard-open-blocker');
    expect(card?.effectivePriority).toBe(3);
    expect(card?.priorityInheritedFrom).toBeNull();
  });

  it('terminates on cyclic blocks and shares the minimum priority within the cycle', () => {
    const ticketA = makeTicket({
      id: 'bdboard-cycle-a',
      status: 'open',
      priority: 2,
      dependencies: [blocksEdge('bdboard-cycle-a', 'bdboard-cycle-b')],
    });
    const ticketB = makeTicket({
      id: 'bdboard-cycle-b',
      status: 'open',
      priority: 0,
      dependencies: [blocksEdge('bdboard-cycle-b', 'bdboard-cycle-a')],
    });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [ticketA, ticketB],
      now: NOW,
    });

    const cardA = board.cards.find((c) => c.ticket.id === 'bdboard-cycle-a');
    const cardB = board.cards.find((c) => c.ticket.id === 'bdboard-cycle-b');
    expect(cardA?.effectivePriority).toBe(0);
    expect(cardB?.effectivePriority).toBe(0);
    expect(cardA?.priorityInheritedFrom).toBe('bdboard-cycle-b');
    expect(cardB?.priorityInheritedFrom).toBeNull();
  });

  it('shares the minimum priority across a three-node cycle regardless of traversal order', () => {
    const ticketA = makeTicket({
      id: 'bdboard-cycle3-a',
      status: 'open',
      priority: 4,
      dependencies: [blocksEdge('bdboard-cycle3-a', 'bdboard-cycle3-c')],
    });
    const ticketB = makeTicket({
      id: 'bdboard-cycle3-b',
      status: 'open',
      priority: 1,
      dependencies: [blocksEdge('bdboard-cycle3-b', 'bdboard-cycle3-a')],
    });
    const ticketC = makeTicket({
      id: 'bdboard-cycle3-c',
      status: 'open',
      priority: 3,
      dependencies: [blocksEdge('bdboard-cycle3-c', 'bdboard-cycle3-b')],
    });

    const board = buildBoard({
      projectId: PROJECT,
      tickets: [ticketA, ticketB, ticketC],
      now: NOW,
    });

    const cardA = board.cards.find((c) => c.ticket.id === 'bdboard-cycle3-a');
    const cardB = board.cards.find((c) => c.ticket.id === 'bdboard-cycle3-b');
    const cardC = board.cards.find((c) => c.ticket.id === 'bdboard-cycle3-c');

    expect(cardA?.effectivePriority).toBe(1);
    expect(cardB?.effectivePriority).toBe(1);
    expect(cardC?.effectivePriority).toBe(1);
    expect(cardA?.priorityInheritedFrom).toBe('bdboard-cycle3-b');
    expect(cardB?.priorityInheritedFrom).toBeNull();
    expect(cardC?.priorityInheritedFrom).toBe('bdboard-cycle3-b');
  });

  it('breaks ties on own priority when effectivePriority matches', () => {
    const higherOwn = makeCard(
      makeTicket({ id: 'bdboard-own-high', priority: 1, updatedAt: BASE }),
      { effectivePriority: 0 },
    );
    const lowerOwn = makeCard(
      makeTicket({ id: 'bdboard-own-low', priority: 0, updatedAt: BASE }),
      { effectivePriority: 0 },
    );

    expect(compareCards(lowerOwn, higherOwn)).toBeLessThan(0);
    expect(compareCards(higherOwn, lowerOwn)).toBeGreaterThan(0);
  });

  it('chooses priorityInheritedFrom deterministically when multiple successors tie', () => {
    const blocker = makeTicket({
      id: 'bdboard-tie-blocker',
      status: 'open',
      priority: 3,
      dependencies: [],
    });
    const succA = makeTicket({
      id: 'bdboard-tie-aaa',
      status: 'open',
      priority: 0,
      dependencies: [blocksEdge('bdboard-tie-aaa', 'bdboard-tie-blocker')],
    });
    const succB = makeTicket({
      id: 'bdboard-tie-bbb',
      status: 'open',
      priority: 0,
      dependencies: [blocksEdge('bdboard-tie-bbb', 'bdboard-tie-blocker')],
    });

    const first = buildBoard({
      projectId: PROJECT,
      tickets: [blocker, succA, succB],
      now: NOW,
    });
    const second = buildBoard({
      projectId: PROJECT,
      tickets: [succB, blocker, succA],
      now: NOW,
    });

    const firstCard = first.cards.find((c) => c.ticket.id === 'bdboard-tie-blocker');
    const secondCard = second.cards.find((c) => c.ticket.id === 'bdboard-tie-blocker');
    expect(firstCard?.priorityInheritedFrom).toBe('bdboard-tie-aaa');
    expect(secondCard?.priorityInheritedFrom).toBe('bdboard-tie-aaa');
  });
});
