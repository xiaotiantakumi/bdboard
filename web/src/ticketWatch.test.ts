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
    liveness: null,
    sessions: [],
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
  it('diffs lane, comment count, and session link changes', () => {
    const prev = {
      ticketId: 'bdboard-abc',
      lane: 'ready',
      commentCount: 1,
      sessionIds: ['session-a'],
    };
    const next = {
      ticketId: 'bdboard-abc',
      lane: 'in_progress',
      commentCount: 2,
      sessionIds: ['session-a', 'session-b'],
    };

    expect(diffTicketWatchSnapshots(prev, next)).toEqual([
      {
        kind: 'lane_changed',
        ticketId: 'bdboard-abc',
        fromLane: 'ready',
        toLane: 'in_progress',
      },
      {
        kind: 'comment_count_changed',
        ticketId: 'bdboard-abc',
        fromCount: 1,
        toCount: 2,
      },
      {
        kind: 'session_links_changed',
        ticketId: 'bdboard-abc',
        addedSessionIds: ['session-b'],
        removedSessionIds: [],
      },
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
      sessions: [
        {
          sessionId: 'session-1',
          pid: 1,
          cwd: '/tmp',
          alive: true,
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-02T00:00:00.000Z',
          liveness: 'active',
        },
      ],
    });

    expect(ticketWatchSnapshotFromBoardCard(card)).toEqual({
      ticketId: 'bdboard-card',
      lane: 'blocked',
      commentCount: 3,
      sessionIds: ['session-1'],
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
      sessionLinks: [{ sessionId: 'session-x', source: 'metadata' as const }],
      models: [],
      children: [],
    };

    expect(ticketWatchSnapshotFromTicketDetail(detail)).toEqual({
      ticketId: 'bdboard-detail',
      lane: null,
      commentCount: 0,
      sessionIds: ['session-x'],
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
          sessionLinks: [],
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
