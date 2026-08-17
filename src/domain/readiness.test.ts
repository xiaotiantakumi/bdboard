import { describe, expect, it } from 'vitest';
import type { DependencyEdge } from './dependency.js';
import {
  createReadinessContext,
  deriveLane,
  isBlocked,
  isBlockedWide,
  isDeferred,
  isReady,
  LANES,
  openBlockerIds,
  type Lane,
} from './readiness.js';
import { makeTicket } from './test-support.js';
import type { Status } from './status.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const PAST = new Date('2026-01-01T00:00:00.000Z');
const FUTURE = new Date('2026-12-31T00:00:00.000Z');

function blocksEdge(
  issueId: string,
  dependsOnId: string,
): DependencyEdge {
  return { issueId, dependsOnId, kind: 'blocks' };
}

function parentChildEdge(
  issueId: string,
  dependsOnId: string,
): DependencyEdge {
  return { issueId, dependsOnId, kind: 'parent-child' };
}

function ctxWithStatuses(
  entries: readonly { id: string; status: Status }[],
) {
  const tickets = entries.map(({ id, status }) =>
    makeTicket({ id, status }),
  );
  return createReadinessContext(tickets);
}

describe('LANES column order (bdboard-662)', () => {
  it('orders columns as 着手可能 → 進行中 → 確認待ち → ブロック → 完了, with no separate deferred lane', () => {
    expect(LANES).toEqual(['ready', 'in_progress', 'awaiting_human', 'blocked', 'done']);
  });
});

describe('createReadinessContext', () => {
  it('uses the first ticket when duplicate ids exist', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-dup', status: 'open' }),
      makeTicket({ id: 'bdboard-dup', status: 'closed' }),
    ];
    const ctx = createReadinessContext(tickets);
    expect(ctx.statusOf('bdboard-dup')).toBe('open');
  });

  it('does not mutate the input array', () => {
    const tickets = [makeTicket({ id: 'bdboard-a', status: 'open' })];
    const copy = [...tickets];
    createReadinessContext(tickets);
    expect(tickets).toEqual(copy);
  });
});

describe('openBlockerIds', () => {
  it('returns empty when only parent-child dependencies exist', () => {
    const ticket = makeTicket({
      id: 'bdboard-child',
      dependencies: [
        parentChildEdge('bdboard-child', 'bdboard-parent'),
      ],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-parent', status: 'open' },
    ]);
    expect(openBlockerIds(ticket, ctx)).toEqual([]);
  });

  it('includes open blockers for blocks edges where issueId matches ticket', () => {
    const ticket = makeTicket({
      id: 'bdboard-3tw.10',
      dependencies: [
        blocksEdge('bdboard-3tw.10', 'bdboard-3tw.1'),
      ],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-3tw.1', status: 'open' },
    ]);
    expect(openBlockerIds(ticket, ctx)).toEqual(['bdboard-3tw.1']);
  });

  it('excludes closed blockers', () => {
    const ticket = makeTicket({
      id: 'bdboard-a',
      dependencies: [blocksEdge('bdboard-a', 'bdboard-b')],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-b', status: 'closed' },
    ]);
    expect(openBlockerIds(ticket, ctx)).toEqual([]);
  });

  it('treats in_progress blockers as open', () => {
    const ticket = makeTicket({
      id: 'bdboard-a',
      dependencies: [blocksEdge('bdboard-a', 'bdboard-b')],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-b', status: 'in_progress' },
    ]);
    expect(openBlockerIds(ticket, ctx)).toEqual(['bdboard-b']);
  });

  it('ignores unknown blocker ids', () => {
    const ticket = makeTicket({
      id: 'bdboard-a',
      dependencies: [blocksEdge('bdboard-a', 'bdboard-unknown')],
    });
    const ctx = createReadinessContext([]);
    expect(openBlockerIds(ticket, ctx)).toEqual([]);
  });

  it('ignores edges where issueId does not match the ticket', () => {
    const ticket = makeTicket({
      id: 'bdboard-a',
      dependencies: [blocksEdge('bdboard-other', 'bdboard-b')],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-b', status: 'open' },
    ]);
    expect(openBlockerIds(ticket, ctx)).toEqual([]);
  });

  it('deduplicates duplicate blocks edges to the same blocker', () => {
    const ticket = makeTicket({
      id: 'bdboard-a',
      dependencies: [
        blocksEdge('bdboard-a', 'bdboard-b'),
        blocksEdge('bdboard-a', 'bdboard-b'),
      ],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-b', status: 'open' },
    ]);
    expect(openBlockerIds(ticket, ctx)).toEqual(['bdboard-b']);
  });

  it('returns multiple blockers in ascending code-point order', () => {
    const ticket = makeTicket({
      id: 'bdboard-a',
      dependencies: [
        blocksEdge('bdboard-a', 'bdboard-z'),
        blocksEdge('bdboard-a', 'bdboard-m'),
      ],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-z', status: 'open' },
      { id: 'bdboard-m', status: 'open' },
    ]);
    expect(openBlockerIds(ticket, ctx)).toEqual(['bdboard-m', 'bdboard-z']);
  });
});

describe('isDeferred', () => {
  it('returns true when deferUntil is in the future', () => {
    const ticket = makeTicket({ deferUntil: FUTURE });
    expect(isDeferred(ticket, NOW)).toBe(true);
  });

  it('returns false when deferUntil is in the past', () => {
    const ticket = makeTicket({ deferUntil: PAST });
    expect(isDeferred(ticket, NOW)).toBe(false);
  });

  it('returns false when deferUntil is unset', () => {
    const ticket = makeTicket();
    expect(isDeferred(ticket, NOW)).toBe(false);
  });
});

describe('isBlocked', () => {
  it('returns true for open ticket with open blocker', () => {
    const ticket = makeTicket({
      id: 'bdboard-a',
      status: 'open',
      dependencies: [blocksEdge('bdboard-a', 'bdboard-b')],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-b', status: 'open' },
    ]);
    expect(isBlocked(ticket, ctx)).toBe(true);
  });

  it('returns false for in_progress ticket with open blocker', () => {
    const ticket = makeTicket({
      id: 'bdboard-a',
      status: 'in_progress',
      dependencies: [blocksEdge('bdboard-a', 'bdboard-b')],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-b', status: 'open' },
    ]);
    expect(isBlocked(ticket, ctx)).toBe(false);
  });
});

describe('isBlockedWide', () => {
  it('returns true for in_progress ticket with open blocker', () => {
    const ticket = makeTicket({
      id: 'bdboard-a',
      status: 'in_progress',
      dependencies: [blocksEdge('bdboard-a', 'bdboard-b')],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-b', status: 'open' },
    ]);
    expect(isBlockedWide(ticket, ctx)).toBe(true);
  });

  it('returns false for open ticket without blockers', () => {
    const ticket = makeTicket({ status: 'open' });
    const ctx = createReadinessContext([]);
    expect(isBlockedWide(ticket, ctx)).toBe(false);
  });
});

describe('isReady', () => {
  it('returns true for open ticket without blockers or defer', () => {
    const ticket = makeTicket({ status: 'open' });
    const ctx = createReadinessContext([]);
    expect(isReady(ticket, ctx, NOW)).toBe(true);
  });

  it('returns false when blocked by open dependency', () => {
    const ticket = makeTicket({
      id: 'bdboard-a',
      status: 'open',
      dependencies: [blocksEdge('bdboard-a', 'bdboard-b')],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-b', status: 'open' },
    ]);
    expect(isReady(ticket, ctx, NOW)).toBe(false);
  });

  it('returns true when blocker is closed', () => {
    const ticket = makeTicket({
      id: 'bdboard-a',
      status: 'open',
      dependencies: [blocksEdge('bdboard-a', 'bdboard-b')],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-b', status: 'closed' },
    ]);
    expect(isReady(ticket, ctx, NOW)).toBe(true);
  });

  it('returns false when deferUntil is in the future', () => {
    const ticket = makeTicket({
      status: 'open',
      deferUntil: FUTURE,
    });
    const ctx = createReadinessContext([]);
    expect(isReady(ticket, ctx, NOW)).toBe(false);
  });

  it('returns true when deferUntil is in the past', () => {
    const ticket = makeTicket({
      status: 'open',
      deferUntil: PAST,
    });
    const ctx = createReadinessContext([]);
    expect(isReady(ticket, ctx, NOW)).toBe(true);
  });
});

describe('deriveLane', () => {
  it('returns in_progress for in_progress with blocker (not blocked lane)', () => {
    const ticket = makeTicket({
      id: 'bdboard-a',
      status: 'in_progress',
      dependencies: [blocksEdge('bdboard-a', 'bdboard-b')],
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-b', status: 'open' },
    ]);
    expect(deriveLane(ticket, ctx, NOW)).toBe('in_progress');
    expect(isBlocked(ticket, ctx)).toBe(false);
    expect(isBlockedWide(ticket, ctx)).toBe(true);
  });

  it.each<[string, Lane]>([
    ['done', 'done'],
    ['in_progress', 'in_progress'],
    ['blocked', 'blocked'],
    ['derived_blocked', 'blocked'],
    // bdboard-662: 保留(deferred)はブロックへ表示統合される(status 自体は変えない)
    ['deferred_status', 'blocked'],
    ['deferred_until', 'blocked'],
    ['ready', 'ready'],
  ])('returns %s lane for %s case', (caseName, expectedLane) => {
    const cases: Record<string, { ticket: ReturnType<typeof makeTicket>; ctx: ReturnType<typeof createReadinessContext> }> = {
      done: {
        ticket: makeTicket({ status: 'closed' }),
        ctx: createReadinessContext([]),
      },
      in_progress: {
        ticket: makeTicket({ status: 'in_progress' }),
        ctx: createReadinessContext([]),
      },
      blocked: {
        ticket: makeTicket({ status: 'blocked' }),
        ctx: createReadinessContext([]),
      },
      derived_blocked: {
        ticket: makeTicket({
          id: 'bdboard-a',
          status: 'open',
          dependencies: [blocksEdge('bdboard-a', 'bdboard-b')],
        }),
        ctx: ctxWithStatuses([{ id: 'bdboard-b', status: 'open' }]),
      },
      deferred_status: {
        ticket: makeTicket({ status: 'deferred' }),
        ctx: createReadinessContext([]),
      },
      deferred_until: {
        ticket: makeTicket({
          status: 'open',
          deferUntil: FUTURE,
        }),
        ctx: createReadinessContext([]),
      },
      ready: {
        ticket: makeTicket({ status: 'open' }),
        ctx: createReadinessContext([]),
      },
    };

    const { ticket, ctx } = cases[caseName]!;
    expect(deriveLane(ticket, ctx, NOW)).toBe(expectedLane);
  });

  it('returns in_progress lane for hooked status', () => {
    const ticket = makeTicket({ status: 'hooked' });
    const ctx = createReadinessContext([]);
    expect(deriveLane(ticket, ctx, NOW)).toBe('in_progress');
  });

  it('returns ready lane for pinned status without blockers or defer', () => {
    const ticket = makeTicket({ status: 'pinned' });
    const ctx = createReadinessContext([]);
    expect(deriveLane(ticket, ctx, NOW)).toBe('ready');
    expect(isReady(ticket, ctx, NOW)).toBe(true);
  });

  it('puts custom status in ready lane but excludes it from isReady', () => {
    const ticket = makeTicket({ status: 'triaged' });
    const ctx = createReadinessContext([]);
    expect(deriveLane(ticket, ctx, NOW)).toBe('ready');
    expect(isReady(ticket, ctx, NOW)).toBe(false);
  });

  it('covers all LANES values', () => {
    const produced = new Set<Lane>();
    const scenarios = [
      makeTicket({ status: 'closed' }),
      makeTicket({ status: 'in_progress' }),
      makeTicket({ status: 'blocked' }),
      makeTicket({
        id: 'bdboard-a',
        status: 'open',
        dependencies: [blocksEdge('bdboard-a', 'bdboard-b')],
      }),
      makeTicket({ status: 'deferred' }),
      makeTicket({ status: 'open', deferUntil: FUTURE }),
      makeTicket({ status: 'open' }),
      makeTicket({ id: 'bdboard-waiting', status: 'open' }),
    ];
    const ctx = ctxWithStatuses([
      { id: 'bdboard-b', status: 'open' },
    ]);
    const emptyCtx = createReadinessContext([]);
    const humanLabeledIds = new Set(['bdboard-waiting']);

    for (const ticket of scenarios) {
      const context =
        ticket.dependencies.length > 0 ? ctx : emptyCtx;
      produced.add(deriveLane(ticket, context, NOW, humanLabeledIds));
    }

    expect([...produced].sort()).toEqual([...LANES].sort());
  });

  describe('awaiting_human (human ラベル)', () => {
    it('routes a human-labeled open ticket to awaiting_human instead of ready', () => {
      const ticket = makeTicket({ id: 'bdboard-waiting', status: 'open' });
      const ctx = createReadinessContext([]);
      const humanLabeledIds = new Set(['bdboard-waiting']);

      expect(deriveLane(ticket, ctx, NOW, humanLabeledIds)).toBe('awaiting_human');
    });

    it('routes a human-labeled blocked ticket to awaiting_human instead of blocked', () => {
      const ticket = makeTicket({
        id: 'bdboard-a',
        status: 'open',
        dependencies: [blocksEdge('bdboard-a', 'bdboard-b')],
      });
      const ctx = ctxWithStatuses([{ id: 'bdboard-b', status: 'open' }]);
      const humanLabeledIds = new Set(['bdboard-a']);

      expect(deriveLane(ticket, ctx, NOW, humanLabeledIds)).toBe('awaiting_human');
    });

    it('routes a human-labeled deferred ticket to awaiting_human instead of blocked', () => {
      const ticket = makeTicket({ status: 'open', deferUntil: FUTURE });
      const ctx = createReadinessContext([]);
      const humanLabeledIds = new Set([ticket.id]);

      expect(deriveLane(ticket, ctx, NOW, humanLabeledIds)).toBe('awaiting_human');
    });

    it('routes a human-labeled in_progress ticket to awaiting_human instead of in_progress', () => {
      const ticket = makeTicket({ status: 'in_progress' });
      const ctx = createReadinessContext([]);
      const humanLabeledIds = new Set([ticket.id]);

      expect(deriveLane(ticket, ctx, NOW, humanLabeledIds)).toBe('awaiting_human');
    });

    it('keeps a closed ticket in done even if it is still human-labeled', () => {
      const ticket = makeTicket({ status: 'closed' });
      const ctx = createReadinessContext([]);
      const humanLabeledIds = new Set([ticket.id]);

      expect(deriveLane(ticket, ctx, NOW, humanLabeledIds)).toBe('done');
    });

    it('ignores an unrelated human-labeled id and keeps the normal lane', () => {
      const ticket = makeTicket({ id: 'bdboard-normal', status: 'open' });
      const ctx = createReadinessContext([]);
      const humanLabeledIds = new Set(['bdboard-other']);

      expect(deriveLane(ticket, ctx, NOW, humanLabeledIds)).toBe('ready');
    });

    it('keeps the normal lane when humanLabeledIds is omitted (no behavior change)', () => {
      const ticket = makeTicket({ status: 'open' });
      const ctx = createReadinessContext([]);

      expect(deriveLane(ticket, ctx, NOW)).toBe('ready');
    });

    it('keeps the normal lane when humanLabeledIds is an empty set', () => {
      const ticket = makeTicket({ status: 'open' });
      const ctx = createReadinessContext([]);

      expect(deriveLane(ticket, ctx, NOW, new Set())).toBe('ready');
    });
  });
});

describe('hierarchical ticket ids', () => {
  const hierarchicalDeps = [
    blocksEdge('bdboard-3tw.10', 'bdboard-3tw.1'),
    parentChildEdge('bdboard-3tw.10', 'bdboard-3tw'),
  ];

  it('does not block on open parent-child epic when blocks dependency is closed', () => {
    const ticket = makeTicket({
      id: 'bdboard-3tw.10',
      status: 'open',
      dependencies: hierarchicalDeps,
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-3tw.10', status: 'open' },
      { id: 'bdboard-3tw.1', status: 'closed' },
      { id: 'bdboard-3tw', status: 'open' },
    ]);

    expect(openBlockerIds(ticket, ctx)).toEqual([]);
    expect(isBlocked(ticket, ctx)).toBe(false);
    expect(isReady(ticket, ctx, NOW)).toBe(true);
    expect(deriveLane(ticket, ctx, NOW)).toBe('ready');
  });

  it('blocks on open blocks dependency with hierarchical ids', () => {
    const ticket = makeTicket({
      id: 'bdboard-3tw.10',
      status: 'open',
      dependencies: hierarchicalDeps,
    });
    const ctx = ctxWithStatuses([
      { id: 'bdboard-3tw.10', status: 'open' },
      { id: 'bdboard-3tw.1', status: 'open' },
      { id: 'bdboard-3tw', status: 'open' },
    ]);

    expect(openBlockerIds(ticket, ctx)).toEqual(['bdboard-3tw.1']);
    expect(isBlocked(ticket, ctx)).toBe(true);
    expect(isReady(ticket, ctx, NOW)).toBe(false);
    expect(deriveLane(ticket, ctx, NOW)).toBe('blocked');
  });
});
