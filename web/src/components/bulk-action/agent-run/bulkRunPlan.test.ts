import { describe, expect, it } from 'vitest';
import {
  cardsByIdOf,
  makeHarnessStatus,
  makeRunBoard,
  makeRunCard,
  makeSplitView,
} from '../../../test/bulkRunFixtures';
import {
  buildBulkRunPlan,
  classifyBulkRunCard,
  collectReadyDisplayOrder,
  describeBulkRunExclusions,
  describeBulkRunHarnessBlock,
} from './bulkRunPlan';

describe('classifyBulkRunCard', () => {
  it('accepts a non-epic card in the ready lane', () => {
    expect(classifyBulkRunCard(makeRunCard('a'))).toBeNull();
  });

  it('reports cards that are not on the board as missing', () => {
    expect(classifyBulkRunCard(undefined)).toBe('missing');
  });

  it('reports an epic as epic even when it sits in the ready lane', () => {
    expect(classifyBulkRunCard(makeRunCard('e', { issueType: 'epic' }))).toBe('epic');
    expect(classifyBulkRunCard(makeRunCard('e', { issueType: 'epic', lane: 'blocked' }))).toBe(
      'epic',
    );
  });

  it('separates the blocked lane from the other non-ready lanes', () => {
    expect(classifyBulkRunCard(makeRunCard('b', { lane: 'blocked' }))).toBe('blocked');
    for (const lane of ['in_progress', 'awaiting_human', 'done']) {
      expect(classifyBulkRunCard(makeRunCard('x', { lane }))).toBe('not-ready');
    }
  });

  // bdboard-xuuz: 既に実行中のエージェントがあるカードを対象外にする。
  it('reports a ready-lane card with an active run as running', () => {
    const runningIds = new Set(['a']);
    expect(classifyBulkRunCard(makeRunCard('a'), runningIds)).toBe('running');
  });

  it('does not report running for a card whose id is absent from runningTicketIds', () => {
    const runningIds = new Set(['other']);
    expect(classifyBulkRunCard(makeRunCard('a'), runningIds)).toBeNull();
  });

  it('treats running as unknown (does not exclude) when runningTicketIds is omitted', () => {
    expect(classifyBulkRunCard(makeRunCard('a'))).toBeNull();
  });

  it('reports blocked (not running) for a blocked-lane card that also has an active run', () => {
    const runningIds = new Set(['b']);
    expect(classifyBulkRunCard(makeRunCard('b', { lane: 'blocked' }), runningIds)).toBe(
      'blocked',
    );
  });

  it('reports epic (not running) for an epic card that also has an active run', () => {
    const runningIds = new Set(['e']);
    expect(
      classifyBulkRunCard(makeRunCard('e', { issueType: 'epic' }), runningIds),
    ).toBe('epic');
  });
});

describe('collectReadyDisplayOrder', () => {
  it('returns an empty order while the board is unknown', () => {
    expect(collectReadyDisplayOrder(undefined)).toEqual([]);
  });

  it('lists merged ready cards first, then each project section in screen order, without duplicates', () => {
    const shared = makeRunCard('shared');
    const view = makeSplitView([
      { id: 'p2', cards: [makeRunCard('p2-a'), shared, makeRunCard('p2-blocked', { lane: 'blocked' })] },
      { id: 'p1', cards: [makeRunCard('p1-a')] },
    ]);
    const withMerged = { ...view, merged: makeRunBoard([makeRunCard('m-1'), shared]) };

    expect(collectReadyDisplayOrder(view)).toEqual(['p2-a', 'shared', 'p1-a']);
    expect(collectReadyDisplayOrder(withMerged)).toEqual(['m-1', 'shared', 'p2-a', 'p1-a']);
  });
});

describe('buildBulkRunPlan', () => {
  it('orders run targets by display order regardless of the selection order', () => {
    const cards = [makeRunCard('t-3'), makeRunCard('t-1'), makeRunCard('t-2')];
    const plan = buildBulkRunPlan(
      new Set(['t-2', 't-1', 't-3']),
      cardsByIdOf(cards),
      ['t-3', 't-1', 't-2'],
    );

    expect(plan.runTicketIds).toEqual(['t-3', 't-1', 't-2']);
    expect(plan.runCards.map((card) => card.ticket.id)).toEqual(['t-3', 't-1', 't-2']);
    expect(plan.exclusions).toEqual([]);
    expect(plan.excludedCount).toBe(0);
  });

  it('interleaves projects by priority and breaks ties with the section order (split view)', () => {
    const p2High = makeRunCard('p2-high', { projectId: 'p2', priority: 1 });
    const p2Low = makeRunCard('p2-low', { projectId: 'p2', priority: 3 });
    const p1High = makeRunCard('p1-high', { projectId: 'p1', priority: 1 });
    const p1Mid = makeRunCard('p1-mid', { projectId: 'p1', priority: 2 });
    const view = makeSplitView([
      { id: 'p2', cards: [p2High, p2Low] },
      { id: 'p1', cards: [p1High, p1Mid] },
    ]);
    const plan = buildBulkRunPlan(
      new Set(['p1-mid', 'p2-low', 'p1-high', 'p2-high']),
      cardsByIdOf([p2High, p2Low, p1High, p1Mid]),
      collectReadyDisplayOrder(view),
    );

    expect(plan.runTicketIds).toEqual(['p2-high', 'p1-high', 'p1-mid', 'p2-low']);
  });

  it('puts an inherited (effective) priority ahead of the own priority', () => {
    const inherited = makeRunCard('inherited', { priority: 3, effectivePriority: 0 });
    const own = makeRunCard('own', { priority: 1 });
    const plan = buildBulkRunPlan(
      new Set(['own', 'inherited']),
      cardsByIdOf([own, inherited]),
      ['own', 'inherited'],
    );

    expect(plan.runTicketIds).toEqual(['inherited', 'own']);
  });

  it('keeps ids missing from the display order after the displayed ones of the same priority', () => {
    const shown = makeRunCard('shown');
    const unlisted = makeRunCard('unlisted');
    const plan = buildBulkRunPlan(
      new Set(['unlisted', 'shown']),
      cardsByIdOf([shown, unlisted]),
      ['shown'],
    );

    expect(plan.runTicketIds).toEqual(['shown', 'unlisted']);
  });

  it('drops excluded cards and counts them per reason in a fixed order', () => {
    const cards = [
      makeRunCard('ok'),
      makeRunCard('epic', { issueType: 'epic' }),
      makeRunCard('blocked-1', { lane: 'blocked' }),
      makeRunCard('blocked-2', { lane: 'blocked' }),
      makeRunCard('doing', { lane: 'in_progress' }),
    ];
    const plan = buildBulkRunPlan(
      new Set(['gone', 'doing', 'blocked-2', 'ok', 'blocked-1', 'epic']),
      cardsByIdOf(cards),
      ['ok'],
    );

    expect(plan.runTicketIds).toEqual(['ok']);
    expect(plan.exclusions).toEqual([
      { reason: 'epic', count: 1 },
      { reason: 'blocked', count: 2 },
      { reason: 'not-ready', count: 1 },
      { reason: 'missing', count: 1 },
    ]);
    expect(plan.excludedCount).toBe(5);
  });

  it('returns an empty run list when every selected card is excluded', () => {
    const plan = buildBulkRunPlan(
      new Set(['e']),
      cardsByIdOf([makeRunCard('e', { issueType: 'epic' })]),
      [],
    );

    expect(plan.runTicketIds).toEqual([]);
    expect(plan.excludedCount).toBe(1);
  });

  // bdboard-xuuz: 既に実行中のエージェントがあるカードを対象外にする。
  it('excludes ready-lane cards with an active run and counts them as running', () => {
    const cards = [
      makeRunCard('ok'),
      makeRunCard('busy-1'),
      makeRunCard('busy-2'),
      makeRunCard('epic', { issueType: 'epic' }),
    ];
    const plan = buildBulkRunPlan(
      new Set(['ok', 'busy-1', 'busy-2', 'epic']),
      cardsByIdOf(cards),
      ['ok', 'busy-1', 'busy-2'],
      new Set(['busy-1', 'busy-2']),
    );

    expect(plan.runTicketIds).toEqual(['ok']);
    expect(plan.exclusions).toEqual([
      { reason: 'epic', count: 1 },
      { reason: 'running', count: 2 },
    ]);
    expect(plan.excludedCount).toBe(3);
  });

  it('does not exclude anything as running when runningTicketIds is omitted', () => {
    const cards = [makeRunCard('a'), makeRunCard('b')];
    const plan = buildBulkRunPlan(new Set(['a', 'b']), cardsByIdOf(cards), ['a', 'b']);

    expect(plan.runTicketIds).toEqual(['a', 'b']);
    expect(plan.exclusions).toEqual([]);
  });

  it('a blocked card with an active run is counted as blocked, not running', () => {
    const cards = [makeRunCard('b', { lane: 'blocked' })];
    const plan = buildBulkRunPlan(
      new Set(['b']),
      cardsByIdOf(cards),
      [],
      new Set(['b']),
    );

    expect(plan.exclusions).toEqual([{ reason: 'blocked', count: 1 }]);
  });
});

describe('describeBulkRunExclusions', () => {
  it('returns null when nothing is excluded', () => {
    expect(describeBulkRunExclusions([])).toBeNull();
  });

  it('joins each reason label with its count', () => {
    expect(
      describeBulkRunExclusions([
        { reason: 'epic', count: 1 },
        { reason: 'blocked', count: 2 },
        { reason: 'not-ready', count: 3 },
        { reason: 'missing', count: 4 },
      ]),
    ).toBe('epic 1 件・ブロック中 2 件・着手可能レーン以外 3 件・ボード上に見つからない 4 件');
  });

  it('includes the running label in the reason join (bdboard-xuuz)', () => {
    expect(
      describeBulkRunExclusions([
        { reason: 'not-ready', count: 1 },
        { reason: 'running', count: 2 },
      ]),
    ).toBe('着手可能レーン以外 1 件・実行中 2 件');
  });
});

describe('describeBulkRunHarnessBlock', () => {
  const projectNames = new Map([
    ['proj-1', 'Project One'],
    ['proj-2', 'Project Two'],
  ]);

  it('does not block while the harness statuses are unknown', () => {
    expect(describeBulkRunHarnessBlock([makeRunCard('a')], undefined, projectNames)).toBeNull();
  });

  it('does not block a project whose status is not loaded yet', () => {
    expect(describeBulkRunHarnessBlock([makeRunCard('a')], new Map(), projectNames)).toBeNull();
  });

  it('returns null when every run project satisfies the prerequisites', () => {
    const statuses = new Map([['proj-1', makeHarnessStatus(true)]]);
    expect(describeBulkRunHarnessBlock([makeRunCard('a')], statuses, projectNames)).toBeNull();
  });

  it('names every blocked project once, in run order', () => {
    const statuses = new Map([
      ['proj-1', makeHarnessStatus(false)],
      ['proj-2', makeHarnessStatus(false)],
      ['proj-3', makeHarnessStatus(true)],
    ]);
    const runCards = [
      makeRunCard('b-1', { projectId: 'proj-2' }),
      makeRunCard('a-1', { projectId: 'proj-1' }),
      makeRunCard('b-2', { projectId: 'proj-2' }),
      makeRunCard('c-1', { projectId: 'proj-3' }),
    ];

    expect(describeBulkRunHarnessBlock(runCards, statuses, projectNames)).toBe(
      'Project Two: ハーネス未注入 — Hygiene から注入 / Project One: ハーネス未注入 — Hygiene から注入',
    );
  });

  it('falls back to the last path segment of the project id when the name is unknown', () => {
    const statuses = new Map([['/work/repos/unnamed', makeHarnessStatus(false)]]);
    const runCards = [makeRunCard('u', { projectId: '/work/repos/unnamed' })];

    expect(describeBulkRunHarnessBlock(runCards, statuses, projectNames)).toBe(
      'unnamed: ハーネス未注入 — Hygiene から注入',
    );
  });

  it('ignores projects that only appear among excluded cards (they are not in runCards)', () => {
    const statuses = new Map([
      ['proj-1', makeHarnessStatus(true)],
      ['proj-2', makeHarnessStatus(false)],
    ]);
    const plan = buildBulkRunPlan(
      new Set(['ok', 'epic-elsewhere']),
      cardsByIdOf([
        makeRunCard('ok', { projectId: 'proj-1' }),
        makeRunCard('epic-elsewhere', { projectId: 'proj-2', issueType: 'epic' }),
      ]),
      ['ok'],
    );

    expect(describeBulkRunHarnessBlock(plan.runCards, statuses, projectNames)).toBeNull();
  });
});
