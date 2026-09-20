// bdboard-sso1.12: dto.ts のモジュール分割。チケット検索結果とアクティビティ
// フィードの DTO。board-routes.ts / ticket-read-routes.ts の両方が参照する
// (barrel 経由)。
import type { ActivityEvent } from '../../../application/board/get-activity-feed.js';
import type { TicketSearchHit } from '../../../application/board/search-tickets.js';

export interface TicketSearchResultDto {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
}

export interface ActivityEventDto {
  kind:
    | 'created'
    | 'started'
    | 'closed'
    | 'status_changed'
    | 'priority_changed'
    | 'field_changed';
  at: string;
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  actor?: string;
  reason?: string;
  from?: string;
  to?: string;
}

export function toTicketSearchResultDto(hit: TicketSearchHit): TicketSearchResultDto {
  return {
    id: hit.ticket.id,
    projectId: hit.ticket.projectId,
    projectName: hit.project.name,
    title: hit.ticket.title,
    status: hit.ticket.status,
    priority: hit.ticket.priority,
    issueType: hit.ticket.issueType,
  };
}

export function toActivityEventDto(event: ActivityEvent): ActivityEventDto {
  return {
    kind: event.kind,
    at: event.at.toISOString(),
    id: event.ticket.id,
    projectId: event.ticket.projectId,
    projectName: event.project.name,
    title: event.ticket.title,
    status: event.ticket.status,
    priority: event.ticket.priority,
    issueType: event.ticket.issueType,
    ...(event.actor !== undefined ? { actor: event.actor } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.from !== undefined ? { from: event.from } : {}),
    ...(event.to !== undefined ? { to: event.to } : {}),
  };
}
