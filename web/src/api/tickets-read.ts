import type { Lane } from './board';
import { fetchJson } from './http';

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

export interface DependencyEdgeDto {
  issueId: string;
  dependsOnId: string;
  kind: string;
}

/**
 * source: 'metadata' は bdboard.session メタデータ経由の手動リンク、
 * 'transcript' はトランスクリプトからの自動推定リンク(bdboard-3tw.9)。
 */
export interface TicketSessionLinkDto {
  sessionId: string;
  source: 'metadata' | 'transcript';
}

/** `bdboard.model.<工程>` メタデータ由来の、工程ごとの使用モデル。 */
export interface TicketModelDto {
  stage: string;
  model: string;
}

export interface TicketDetailDto extends TicketSummaryDto {
  description?: string;
  notes?: string;
  dependencies: DependencyEdgeDto[];
  blockedBy: string[];
  blocks: string[];
  usage?: TicketTokenUsageDto;
  sessionLinks: TicketSessionLinkDto[];
  models: TicketModelDto[];
  children: TicketChildDto[];
}

export interface TicketChildDto {
  id: string;
  title: string;
  lane: Lane;
}

export interface ModelUsageDto {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface TicketTokenUsageDto {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  byModel: ModelUsageDto[];
}

export interface CommentDto {
  id: string;
  issueId: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface TicketSearchResultDto {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
}

export interface TicketSimilarResultDto {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  score: number;
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

/** チケット詳細パネルの「衝突しうる着手中チケット」1 行ぶん */
export interface TicketInFlightOverlapDto {
  ticketId: string;
  files: string[];
}

export function fetchTicket(id: string): Promise<TicketDetailDto> {
  return fetchJson<TicketDetailDto>(`/api/tickets/${encodeURIComponent(id)}`);
}

export function fetchTicketComments(ticketId: string): Promise<CommentDto[]> {
  return fetchJson<CommentDto[]>(
    `/api/comments/${encodeURIComponent(ticketId)}`,
  );
}

export function searchTickets(
  query: string,
  limit = 30,
): Promise<TicketSearchResultDto[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('q', query);
  searchParams.set('limit', String(limit));
  return fetchJson<TicketSearchResultDto[]>(`/api/search?${searchParams.toString()}`);
}

export function fetchActivity(
  days = 1,
  limit = 100,
  projectIds: readonly string[] = [],
): Promise<ActivityEventDto[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('days', String(days));
  searchParams.set('limit', String(limit));
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  return fetchJson<ActivityEventDto[]>(`/api/activity?${searchParams.toString()}`);
}

export function fetchTicketTimeline(
  ticketId: string,
  limit = 200,
): Promise<ActivityEventDto[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('limit', String(limit));
  return fetchJson<ActivityEventDto[]>(
    `/api/tickets/${encodeURIComponent(ticketId)}/timeline?${searchParams.toString()}`,
  );
}

export function fetchSimilarTickets(
  ticketId: string,
  limit = 5,
): Promise<TicketSimilarResultDto[]> {
  const searchParams = new URLSearchParams();
  searchParams.set('limit', String(limit));
  return fetchJson<TicketSimilarResultDto[]>(
    `/api/tickets/${encodeURIComponent(ticketId)}/similar?${searchParams.toString()}`,
  );
}

export function fetchTicketInFlightOverlaps(
  ticketId: string,
): Promise<TicketInFlightOverlapDto[]> {
  return fetchJson<TicketInFlightOverlapDto[]>(
    `/api/tickets/${encodeURIComponent(ticketId)}/in-flight-overlaps`,
  );
}
