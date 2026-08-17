import { describe, expect, it } from 'vitest';
import type { BoardCardDto, BoardDto } from './api';
import { collectBoardTicketIds } from './boardTicketIds';

function makeCard(id: string, lane: BoardCardDto['lane'] = 'ready'): BoardCardDto {
  return {
    ticket: {
      id,
      projectId: 'proj-1',
      title: id,
      status: lane === 'done' ? 'closed' : 'open',
      priority: 2,
      issueType: 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commentCount: 0,
    },
    lane,
    projectId: 'proj-1',
    blockedBy: [],
    blocks: [],
    unblocksCount: 0,
    liveness: null,
    sessions: [],
    stalled: false,
    epicProgress: null,
    deferDays: null,
    deferUrgency: null,
    effectivePriority: 2,
    priorityInheritedFrom: null,
  };
}

function makeBoard(overrides: Partial<BoardDto> = {}): BoardDto {
  return {
    lanes: {
      awaiting_human: [],
      ready: [],
      in_progress: [],
      blocked: [],
      done: [],
    },
    cardCount: 0,
    closedTotal: 0,
    truncatedClosedIds: [],
    ...overrides,
  };
}

describe('collectBoardTicketIds', () => {
  it('collects ticket ids from every lane', () => {
    const board = makeBoard({
      lanes: {
        awaiting_human: [makeCard('bdboard-wait')],
        ready: [makeCard('bdboard-ready')],
        in_progress: [makeCard('bdboard-progress')],
        // bdboard-662: 保留(deferred)はブロックへ表示統合されたので、依存関係ブロックと
        // 保留由来のカードが同じ blocked レーンに混在しうる。
        blocked: [makeCard('bdboard-blocked'), makeCard('bdboard-deferred', 'blocked')],
        done: [makeCard('bdboard-done', 'done')],
      },
    });

    const ids = new Set<string>();
    collectBoardTicketIds(board, ids);

    expect([...ids].sort()).toEqual([
      'bdboard-blocked',
      'bdboard-deferred',
      'bdboard-done',
      'bdboard-progress',
      'bdboard-ready',
      'bdboard-wait',
    ]);
  });

  it('adds into an existing set without clearing prior entries', () => {
    const board = makeBoard({ lanes: { ...makeBoard().lanes, ready: [makeCard('bdboard-new')] } });
    const ids = new Set(['bdboard-existing']);

    collectBoardTicketIds(board, ids);

    expect([...ids].sort()).toEqual(['bdboard-existing', 'bdboard-new']);
  });

  // load-bearing (bdboard-3tw.86 regression fix, per coordinator review): closedLimit
  // truncates old closed tickets out of lanes.done entirely, so without this the known-ID
  // auto-link feature (bdboard-3tw.64) would treat cross-referenced old closed tickets as
  // unknown IDs and stop linking them. isTicketOnBoard in App.tsx is literally
  // `boardTicketIds.has(ticketId)` where boardTicketIds is built by this function, so
  // asserting the id lands in the collected Set is equivalent to asserting
  // isTicketOnBoard(id) === true for it.
  it('treats closedLimit-truncated ticket ids as present on the board even with no card', () => {
    const board = makeBoard({
      lanes: { ...makeBoard().lanes, done: [makeCard('bdboard-kept', 'done')] },
      closedTotal: 3,
      truncatedClosedIds: ['bdboard-truncated-1', 'bdboard-truncated-2'],
    });

    const ids = new Set<string>();
    collectBoardTicketIds(board, ids);

    // Neither truncated id has a card anywhere in board.lanes...
    expect(board.lanes.done.map((c) => c.ticket.id)).toEqual(['bdboard-kept']);
    // ...but isTicketOnBoard-equivalent lookup must still say "yes, it's on the board".
    expect(ids.has('bdboard-truncated-1')).toBe(true);
    expect(ids.has('bdboard-truncated-2')).toBe(true);
    expect(ids.has('bdboard-kept')).toBe(true);
  });

  it('does nothing when truncatedClosedIds is empty', () => {
    const board = makeBoard();
    const ids = new Set<string>();

    collectBoardTicketIds(board, ids);

    expect(ids.size).toBe(0);
  });
});
