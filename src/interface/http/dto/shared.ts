// bdboard-sso1.12: dto.ts のモジュール分割。チケット概要 DTO はボード(board.ts)と
// チケット詳細(ticket.ts)の両方から参照される共有の基底型なので、どちらにも属さない
// この shared.ts に置き、依存は一方向 (board.ts / ticket.ts → shared.ts) にする。
import type { Ticket } from '../../../domain/ticket.js';

export interface TicketSummaryDto {
  id: string;
  projectId: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  closedAt?: string;
  deferUntil?: string;
  assignee?: string;
  owner?: string;
  parentId?: string;
  commentCount: number;
  labels?: string[];
}

export function toTicketSummaryDto(ticket: Ticket): TicketSummaryDto {
  return {
    id: ticket.id,
    projectId: ticket.projectId,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    issueType: ticket.issueType,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    ...(ticket.startedAt !== undefined
      ? { startedAt: ticket.startedAt.toISOString() }
      : {}),
    ...(ticket.closedAt !== undefined
      ? { closedAt: ticket.closedAt.toISOString() }
      : {}),
    ...(ticket.deferUntil !== undefined
      ? { deferUntil: ticket.deferUntil.toISOString() }
      : {}),
    ...(ticket.assignee !== undefined ? { assignee: ticket.assignee } : {}),
    ...(ticket.owner !== undefined ? { owner: ticket.owner } : {}),
    ...(ticket.parentId !== undefined ? { parentId: ticket.parentId } : {}),
    commentCount: ticket.commentCount,
    ...(ticket.labels !== undefined ? { labels: [...ticket.labels] } : {}),
  };
}
