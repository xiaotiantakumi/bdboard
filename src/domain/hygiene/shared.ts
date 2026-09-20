import { isBlockingKind } from '../dependency.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';

/**
 * 確認待ち集合のキー。
 *
 * ticket.id だけで持つと、同じIDのチケットを持つ別プロジェクトが同時にスコープへ
 * 入っているときに取り違える。bd のIDはプロジェクト内でしか一意ではなく、盤面側は
 * humanLabeledIdsFromCache を **プロジェクト単位** で作っている
 * (src/application/board/get-board.ts) ので、健全性だけ全プロジェクト混ぜた集合で
 * 判定すると、盤面では通常レーンのチケットに「確認待ちが放置されている」が付く。
 * 依存循環の辺キー(collectCycleEdges)と同じ \0 結合で projectId を前置する。
 */
export function pendingDecisionKey(
  projectId: string,
  ticketId: TicketId,
): string {
  return `${projectId}\0${ticketId}`;
}

export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function inProgressAnchor(ticket: Ticket): Date | null {
  if (isValidDate(ticket.startedAt)) {
    return ticket.startedAt;
  }
  if (isValidDate(ticket.updatedAt)) {
    return ticket.updatedAt;
  }
  return null;
}

export function hasBlockingDependencies(ticket: Ticket): boolean {
  return ticket.dependencies.some(
    (edge) => isBlockingKind(edge.kind) && edge.issueId === ticket.id,
  );
}

/**
 * Date を YYYY-MM-DD に整形する。
 *
 * timeZone 未指定時は実行環境のローカルタイムゾーン(getFullYear/getMonth/getDate)。
 * 指定時はその IANA タイムゾーンの暦日(UTC で slice すると JST では 1 日ずれる)。
 */
export function formatLocalDateKey(date: Date, timeZone?: string): string {
  if (timeZone !== undefined) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
