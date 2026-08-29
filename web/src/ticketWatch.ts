import type { BoardCardDto, TicketDetailDto } from './api';

/** Mirrors src/domain/board-notifications TicketWatchSnapshot (web cannot import src/). */
export interface TicketWatchSnapshot {
  readonly ticketId: string;
  readonly source: 'board' | 'detail';
  readonly lane: string | null;
  readonly commentCount: number;
  readonly sessionIds: readonly string[];
  readonly title?: string;
  readonly projectId?: string;
}

export type TicketWatchEvent =
  | {
      readonly kind: 'lane_changed';
      readonly ticketId: string;
      readonly fromLane: string;
      readonly toLane: string;
    }
  | {
      readonly kind: 'comment_count_changed';
      readonly ticketId: string;
      readonly fromCount: number;
      readonly toCount: number;
    }
  | {
      readonly kind: 'session_links_changed';
      readonly ticketId: string;
      readonly addedSessionIds: readonly string[];
      readonly removedSessionIds: readonly string[];
    };

export function ticketWatchSnapshotFromBoardCard(card: BoardCardDto): TicketWatchSnapshot {
  return {
    ticketId: card.ticket.id,
    source: 'board',
    lane: card.lane,
    commentCount: card.ticket.commentCount,
    sessionIds: card.sessions.map((session) => session.sessionId).sort(),
    title: card.ticket.title,
    projectId: card.projectId,
  };
}

export function ticketWatchSnapshotFromTicketDetail(detail: TicketDetailDto): TicketWatchSnapshot {
  return {
    ticketId: detail.id,
    source: 'detail',
    lane: null,
    commentCount: detail.commentCount,
    sessionIds: detail.sessionLinks.map((link) => link.sessionId).sort(),
    title: detail.title,
    projectId: detail.projectId,
  };
}

export function buildTicketWatchSnapshot(
  ticketId: string,
  boardCardsById: ReadonlyMap<string, BoardCardDto>,
  ticketDetailsById: ReadonlyMap<string, TicketDetailDto>,
): TicketWatchSnapshot | null {
  const card = boardCardsById.get(ticketId);
  if (card !== undefined) {
    return ticketWatchSnapshotFromBoardCard(card);
  }
  const detail = ticketDetailsById.get(ticketId);
  if (detail !== undefined) {
    return ticketWatchSnapshotFromTicketDetail(detail);
  }
  return null;
}

function diffSessionIdSets(
  prev: readonly string[],
  next: readonly string[],
): { addedSessionIds: string[]; removedSessionIds: string[] } {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const addedSessionIds = next.filter((sessionId) => !prevSet.has(sessionId));
  const removedSessionIds = prev.filter((sessionId) => !nextSet.has(sessionId));
  return { addedSessionIds, removedSessionIds };
}

export function diffTicketWatchSnapshots(
  prev: TicketWatchSnapshot,
  next: TicketWatchSnapshot,
): readonly TicketWatchEvent[] {
  if (prev.ticketId !== next.ticketId) {
    return [];
  }

  const events: TicketWatchEvent[] = [];
  const ticketId = next.ticketId;

  if (prev.lane !== null && next.lane !== null && prev.lane !== next.lane) {
    events.push({
      kind: 'lane_changed',
      ticketId,
      fromLane: prev.lane,
      toLane: next.lane,
    });
  }

  if (prev.commentCount !== next.commentCount) {
    events.push({
      kind: 'comment_count_changed',
      ticketId,
      fromCount: prev.commentCount,
      toCount: next.commentCount,
    });
  }

  if (prev.source === next.source) {
    const { addedSessionIds, removedSessionIds } = diffSessionIdSets(
      prev.sessionIds,
      next.sessionIds,
    );
    if (addedSessionIds.length > 0 || removedSessionIds.length > 0) {
      events.push({
        kind: 'session_links_changed',
        ticketId,
        addedSessionIds,
        removedSessionIds,
      });
    }
  }

  return events;
}
