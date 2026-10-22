import { describe, expect, it } from 'vitest';
import type { BoardCardDto } from './api';
import {
  buildTicketWatchSnapshot,
  diffTicketWatchSnapshots,
  ticketWatchSnapshotFromBoardCard,
  ticketWatchSnapshotFromTicketDetail,
} from './ticketWatch';

function makeBoardCard(
  overrides: Partial<BoardCardDto> & Pick<BoardCardDto, 'ticket'>,
): BoardCardDto {
  return {
    lane: 'ready',
    projectId: 'proj-1',
    blockedBy: [],
    blocks: [],
    unblocksCount: 0,
    stalled: false,
    epicProgress: null,
    deferDays: null,
    deferUrgency: null,
    effectivePriority: overrides.ticket.priority,
    priorityInheritedFrom: null,
    ...overrides,
  };
}

describe('ticketWatch', () => {
  it('diffs lane and comment count changes', () => {
    const base = {
      ticketId: 'bdboard-a',
      source: 'board' as const,
      lane: 'ready',
      commentCount: 1,
    };
    expect(diffTicketWatchSnapshots(base, { ...base, lane: 'in_progress', commentCount: 2 })).toEqual([
      { kind: 'lane_changed', ticketId: 'bdboard-a', fromLane: 'ready', toLane: 'in_progress' },
      { kind: 'comment_count_changed', ticketId: 'bdboard-a', fromCount: 1, toCount: 2 },
    ]);
  });

  it('builds snapshots from board cards and ticket details', () => {
    const card = makeBoardCard({
      ticket: {
        id: 'bdboard-card',
        projectId: 'proj-1',
        title: 'Card ticket',
        status: 'open',
        priority: 2,
        issueType: 'task',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        commentCount: 3,
      },
      lane: 'blocked',
    });

    expect(ticketWatchSnapshotFromBoardCard(card)).toEqual({
      ticketId: 'bdboard-card',
      source: 'board',
      lane: 'blocked',
      commentCount: 3,
      title: 'Card ticket',
      projectId: 'proj-1',
    });

    const detail = {
      id: 'bdboard-detail',
      projectId: 'proj-2',
      title: 'Detail ticket',
      status: 'open',
      priority: 1,
      issueType: 'bug',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commentCount: 0,
      dependencies: [],
      blockedBy: [],
      blocks: [],
      models: [],
      children: [],
    };

    expect(ticketWatchSnapshotFromTicketDetail(detail)).toEqual({
      ticketId: 'bdboard-detail',
      source: 'detail',
      lane: null,
      commentCount: 0,
      title: 'Detail ticket',
      projectId: 'proj-2',
    });
  });

  it('prefers board card data when building a snapshot', () => {
    const card = makeBoardCard({
      ticket: {
        id: 'bdboard-both',
        projectId: 'proj-1',
        title: 'From board',
        status: 'open',
        priority: 2,
        issueType: 'task',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        commentCount: 1,
      },
    });
    const boardCardsById = new Map([['bdboard-both', card]]);
    const ticketDetailsById = new Map([
      [
        'bdboard-both',
        {
          id: 'bdboard-both',
          projectId: 'proj-ignored',
          title: 'From detail',
          status: 'open',
          priority: 2,
          issueType: 'task',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          commentCount: 9,
          dependencies: [],
          blockedBy: [],
          blocks: [],
          models: [],
          children: [],
        },
      ],
    ]);

    expect(buildTicketWatchSnapshot('bdboard-both', boardCardsById, ticketDetailsById)).toEqual(
      ticketWatchSnapshotFromBoardCard(card),
    );
  });

});
