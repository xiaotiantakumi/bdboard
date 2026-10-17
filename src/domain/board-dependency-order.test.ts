import { describe, expect, it } from 'vitest';
import type { DependencyEdge } from './dependency.js';
import { buildBoard, mergeBoards } from './board.js';
import { makeTicket } from './test-support.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const PROJECT = '/projects/bdboard';

function blocksEdge(issueId: string, dependsOnId: string): DependencyEdge {
  return { issueId, dependsOnId, kind: 'blocks' };
}

function openTicket(
  id: string,
  updatedAt: string,
  dependencies: DependencyEdge[] = [],
  status: 'open' | 'closed' = 'open',
) {
  return makeTicket({
    id,
    status,
    priority: 1,
    updatedAt: new Date(updatedAt),
    dependencies,
  });
}

function humanBoard(
  tickets: ReturnType<typeof openTicket>[],
  humanIds: readonly string[] = tickets.map((ticket) => ticket.id),
  projectId = PROJECT,
) {
  return buildBoard({
    projectId,
    tickets,
    now: NOW,
    humanLabeledIds: new Set(humanIds),
  });
}

function awaitingIds(board: ReturnType<typeof humanBoard>): string[] {
  return board.lanes.awaiting_human.map((card) => card.ticket.id);
}

describe('lane dependency order', () => {
  it('orders awaiting human cards by reviewAfter without changing blocking or lane state', () => {
    const a = openTicket('bdboard-a', '2026-05-01T00:00:00.000Z');
    const b = { ...openTicket('bdboard-b', '2026-05-03T00:00:00.000Z'), reviewAfter: ['bdboard-a'] };
    const board = humanBoard([b, a]);
    expect(awaitingIds(board)).toEqual(['bdboard-a', 'bdboard-b']);
    expect(board.lanes.awaiting_human.find((card) => card.ticket.id === 'bdboard-b')?.blockedBy).toEqual([]);
  });

  it('orders reviewAfter ahead of priority in awaiting_human', () => {
    const a = makeTicket({ id: 'bdboard-a', status: 'open', priority: 2, updatedAt: new Date('2026-05-01T00:00:00.000Z') });
    const b = { ...makeTicket({ id: 'bdboard-b', status: 'open', priority: 0, updatedAt: new Date('2026-05-03T00:00:00.000Z') }), reviewAfter: ['bdboard-a'] };
    const board = humanBoard([b, a]);

    expect(awaitingIds(board)).toEqual(['bdboard-a', 'bdboard-b']);
    expect(board.lanes.awaiting_human.find((card) => card.ticket.id === 'bdboard-b')?.blockedBy).toEqual([]);
  });

  it('ignores reviewAfter predecessor ids that exist only in another project', () => {
    const b = { ...openTicket('bdboard-b', '2026-05-03T00:00:00.000Z'), reviewAfter: ['bdboard-a'] };
    const boardOne = humanBoard([b], ['bdboard-b'], '/p/one');
    const boardTwo = humanBoard(
      [openTicket('bdboard-a', '2026-05-01T00:00:00.000Z')],
      ['bdboard-a'],
      '/p/two',
    );
    const merged = mergeBoards([boardOne, boardTwo]);
    expect(merged.lanes.awaiting_human.map((card) => [card.projectId, card.ticket.id])).toEqual([
      ['/p/one', 'bdboard-b'],
      ['/p/two', 'bdboard-a'],
    ]);
  });

  it('ignores reviewAfter outside awaiting_human and when predecessor is absent or another lane', () => {
    const a = openTicket('bdboard-a', '2026-05-01T00:00:00.000Z');
    const b = { ...openTicket('bdboard-b', '2026-05-03T00:00:00.000Z'), reviewAfter: ['bdboard-a', 'bdboard-missing'] };
    const ready = humanBoard([b, a], []);
    expect(ready.lanes.ready.map((card) => card.ticket.id)).toEqual(['bdboard-b', 'bdboard-a']);
    const split = humanBoard([b, a], ['bdboard-b']);
    expect(awaitingIds(split)).toEqual(['bdboard-b']);
  });

  it('inherits review ordering onto the in-lane gate that blocks the card', () => {
    const a = openTicket('bdboard-a', '2026-05-01T00:00:00.000Z');
    const g = openTicket('bdboard-g', '2026-05-02T00:00:00.000Z');
    const b = { ...openTicket('bdboard-b', '2026-05-03T00:00:00.000Z', [blocksEdge('bdboard-b', 'bdboard-g')]), reviewAfter: ['bdboard-a'] };
    expect(awaitingIds(humanBoard([b, g, a]))).toEqual(['bdboard-a', 'bdboard-g', 'bdboard-b']);
  });

  it('keeps the blocker above a reviewAfter predecessor', () => {
    const a = makeTicket({ id: 'bdboard-a', status: 'open', priority: 0, updatedAt: new Date('2026-05-03T00:00:00.000Z'), dependencies: [blocksEdge('bdboard-a', 'bdboard-b')] });
    const b = { ...makeTicket({ id: 'bdboard-b', status: 'open', priority: 2, updatedAt: new Date('2026-05-01T00:00:00.000Z') }), reviewAfter: ['bdboard-a'] };
    expect(awaitingIds(humanBoard([a, b]))).toEqual(['bdboard-b', 'bdboard-a']);
  });

  it('keeps a shared blocker above both reviewAfter predecessor and dependent card', () => {
    const gate = makeTicket({ id: 'bdboard-g', status: 'open', priority: 2, updatedAt: new Date('2026-05-04T00:00:00.000Z') });
    const predecessor = { ...makeTicket({ id: 'bdboard-p', status: 'open', priority: 0, updatedAt: new Date('2026-05-03T00:00:00.000Z'), dependencies: [blocksEdge('bdboard-p', 'bdboard-g')] }), reviewAfter: [] };
    const b = { ...makeTicket({ id: 'bdboard-b', status: 'open', priority: 0, updatedAt: new Date('2026-05-01T00:00:00.000Z'), dependencies: [blocksEdge('bdboard-b', 'bdboard-g')] }), reviewAfter: ['bdboard-p'] };
    expect(awaitingIds(humanBoard([gate, predecessor, b]))).toEqual(['bdboard-g', 'bdboard-p', 'bdboard-b']);
  });

  it('places every reviewAfter predecessor above a higher-priority card', () => {
    const a = makeTicket({ id: 'bdboard-a', status: 'open', priority: 2, updatedAt: new Date('2026-05-01T00:00:00.000Z') });
    const c = makeTicket({ id: 'bdboard-c', status: 'open', priority: 2, updatedAt: new Date('2026-05-02T00:00:00.000Z') });
    const b = { ...makeTicket({ id: 'bdboard-b', status: 'open', priority: 0, updatedAt: new Date('2026-05-03T00:00:00.000Z') }), reviewAfter: ['bdboard-a', 'bdboard-c'] };
    const ids = awaitingIds(humanBoard([b, a, c]));
    expect(ids.at(-1)).toBe('bdboard-b');
    expect([...ids].sort()).toEqual(['bdboard-a', 'bdboard-b', 'bdboard-c']);
  });

  it('places an in-lane blocker above the newer card it blocks', () => {
    // compareCards (unblocksCount desc, then updatedAt desc) is b, a, d, c.
    // A blocks B and B blocks C in the same lane, so A moves above B: a, b, d, c.
    const board = humanBoard([
      openTicket('bdboard-a', '2026-05-01T00:00:00.000Z'),
      openTicket('bdboard-b', '2026-05-02T00:00:00.000Z', [
        blocksEdge('bdboard-b', 'bdboard-a'),
      ]),
      openTicket('bdboard-c', '2026-05-03T00:00:00.000Z', [
        blocksEdge('bdboard-c', 'bdboard-b'),
      ]),
      openTicket('bdboard-d', '2026-05-04T00:00:00.000Z'),
    ]);

    expect(awaitingIds(board)).toEqual([
      'bdboard-a',
      'bdboard-b',
      'bdboard-d',
      'bdboard-c',
    ]);
  });

  it('keeps compareCards order when there are no dependencies', () => {
    const board = humanBoard([
      openTicket('bdboard-newer', '2026-05-04T00:00:00.000Z'),
      openTicket('bdboard-older', '2026-05-01T00:00:00.000Z'),
    ]);

    expect(awaitingIds(board)).toEqual(['bdboard-newer', 'bdboard-older']);
  });

  it('does not reorder cards for a blocker in a different lane', () => {
    const board = humanBoard(
      [
        openTicket('bdboard-x', '2026-05-03T00:00:00.000Z'),
        openTicket('bdboard-y', '2026-05-02T00:00:00.000Z', [
          blocksEdge('bdboard-y', 'bdboard-x'),
        ]),
        openTicket('bdboard-z', '2026-05-04T00:00:00.000Z'),
      ],
      ['bdboard-y', 'bdboard-z'],
    );

    expect(board.lanes.ready.map((card) => card.ticket.id)).toEqual(['bdboard-x']);
    expect(awaitingIds(board)).toEqual(['bdboard-z', 'bdboard-y']);
  });

  it('keeps compareCards order when the blocker is closed', () => {
    const board = humanBoard(
      [
        openTicket('bdboard-a', '2026-05-03T00:00:00.000Z', [], 'closed'),
        openTicket('bdboard-b', '2026-05-02T00:00:00.000Z', [
          blocksEdge('bdboard-b', 'bdboard-a'),
        ]),
        openTicket('bdboard-e', '2026-05-01T00:00:00.000Z'),
      ],
      ['bdboard-b', 'bdboard-e'],
    );

    expect(awaitingIds(board)).toEqual(['bdboard-b', 'bdboard-e']);
  });

  it('keeps every card once when dependencies cycle', () => {
    const tickets = [
      openTicket('bdboard-p', '2026-05-02T00:00:00.000Z', [
        blocksEdge('bdboard-p', 'bdboard-q'),
      ]),
      openTicket('bdboard-q', '2026-05-03T00:00:00.000Z', [
        blocksEdge('bdboard-q', 'bdboard-p'),
      ]),
      openTicket('bdboard-r', '2026-05-01T00:00:00.000Z'),
    ];
    const board = humanBoard(tickets);
    const ids = awaitingIds(board);

    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set(['bdboard-p', 'bdboard-q', 'bdboard-r']));
    expect(board.cards).toHaveLength(tickets.length);
  });

  it('keeps a high-priority cycle above a lower-priority unrelated card', () => {
    const board = humanBoard([
      makeTicket({
        id: 'bdboard-p',
        priority: 0,
        updatedAt: new Date('2026-05-03T00:00:00.000Z'),
        dependencies: [blocksEdge('bdboard-p', 'bdboard-q')],
      }),
      makeTicket({
        id: 'bdboard-q',
        priority: 0,
        updatedAt: new Date('2026-05-02T00:00:00.000Z'),
        dependencies: [blocksEdge('bdboard-q', 'bdboard-p')],
      }),
      makeTicket({ id: 'bdboard-x', priority: 4, updatedAt: new Date('2026-05-04T00:00:00.000Z') }),
    ]);

    expect(awaitingIds(board)).toEqual(['bdboard-p', 'bdboard-q', 'bdboard-x']);
  });

  it('never lifts a card downstream of a cycle above the cycle', () => {
    // compareCards order is [c, a, b, x]: c is P0, a and b inherit P0 from c, a is newer than b.
    const board = humanBoard([
      makeTicket({
        id: 'bdboard-c',
        priority: 0,
        updatedAt: new Date('2026-05-01T00:00:00.000Z'),
        dependencies: [blocksEdge('bdboard-c', 'bdboard-a')],
      }),
      makeTicket({
        id: 'bdboard-a',
        priority: 1,
        updatedAt: new Date('2026-05-03T00:00:00.000Z'),
        dependencies: [blocksEdge('bdboard-a', 'bdboard-b')],
      }),
      makeTicket({
        id: 'bdboard-b',
        priority: 1,
        updatedAt: new Date('2026-05-02T00:00:00.000Z'),
        dependencies: [blocksEdge('bdboard-b', 'bdboard-a')],
      }),
      makeTicket({ id: 'bdboard-x', priority: 1, updatedAt: new Date('2026-05-04T00:00:00.000Z') }),
    ]);

    expect(awaitingIds(board)).toEqual(['bdboard-a', 'bdboard-b', 'bdboard-c', 'bdboard-x']);
  });

  it('keeps in-lane blocker order after mergeBoards', () => {
    // B and A both unblock one open ticket and B is newer, so compareCards puts B first.
    // A blocks B and B blocks F, so the merged lane is A, B, F.
    const boardOne = humanBoard(
      [
        openTicket('bdboard-a', '2026-05-02T00:00:00.000Z'),
        openTicket('bdboard-b', '2026-05-03T00:00:00.000Z', [
          blocksEdge('bdboard-b', 'bdboard-a'),
        ]),
        openTicket('bdboard-f', '2026-05-01T00:00:00.000Z', [
          blocksEdge('bdboard-f', 'bdboard-b'),
        ]),
      ],
      ['bdboard-a', 'bdboard-b', 'bdboard-f'],
      '/p/one',
    );
    const boardTwo = humanBoard(
      [openTicket('bdboard-g', '2026-05-04T00:00:00.000Z')],
      ['bdboard-g'],
      '/p/two',
    );

    const oneAwaiting = mergeBoards([boardOne, boardTwo])
      .lanes.awaiting_human.filter((card) => card.projectId === '/p/one')
      .map((card) => card.ticket.id);

    expect(oneAwaiting).toEqual(['bdboard-a', 'bdboard-b', 'bdboard-f']);
  });

  it('does not create cross-project edges for the same ticket id', () => {
    const boardOne = humanBoard(
      [
        openTicket('bdboard-x', '2026-05-01T00:00:00.000Z'),
        openTicket('bdboard-y', '2026-05-02T00:00:00.000Z', [
          blocksEdge('bdboard-y', 'bdboard-x'),
        ]),
      ],
      ['bdboard-x', 'bdboard-y'],
      '/p/one',
    );
    const boardTwo = humanBoard(
      [openTicket('bdboard-x', '2026-05-03T00:00:00.000Z')],
      ['bdboard-x'],
      '/p/two',
    );

    const merged = mergeBoards([boardOne, boardTwo]);

    expect(merged.cards).toHaveLength(3);
  });
});
