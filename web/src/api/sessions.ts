import type { Liveness } from '../liveness';
import { fetchJson } from './http';

export interface SessionDto {
  sessionId: string;
  pid: number;
  cwd: string;
  alive: boolean;
  startedAt: string;
  lastActivityAt: string;
  liveness: Liveness;
  name?: string;
}

export interface SessionHistoryTicketDto {
  ticketId: string;
  title?: string;
}

export interface SessionHistoryEntryDto {
  session: SessionDto;
  projectId?: string;
  projectName?: string;
  tickets: SessionHistoryTicketDto[];
}

export interface SessionTailMessageDto {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface SessionTailDto {
  sessionId: string;
  messages: SessionTailMessageDto[];
}

export interface AgentProcessDto {
  pid: number;
  command: string;
  cwd: string;
  startedAt?: string;
  projectId?: string;
  projectName?: string;
}

export function fetchSessions(): Promise<SessionDto[]> {
  return fetchJson<SessionDto[]>('/api/sessions');
}

export function fetchSessionHistory(
  limit?: number,
  projectId?: string,
): Promise<SessionHistoryEntryDto[]> {
  const searchParams = new URLSearchParams();
  if (limit !== undefined) {
    searchParams.set('limit', String(limit));
  }
  if (projectId !== undefined) {
    searchParams.set('projects', projectId);
  }
  const query = searchParams.toString();
  const path =
    query.length > 0 ? `/api/sessions/history?${query}` : '/api/sessions/history';
  return fetchJson<SessionHistoryEntryDto[]>(path);
}

export function fetchSessionTail(
  sessionId: string,
  lines?: number,
): Promise<SessionTailDto> {
  const searchParams = new URLSearchParams();
  if (lines !== undefined) {
    searchParams.set('lines', String(lines));
  }
  const query = searchParams.toString();
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/tail${
    query.length > 0 ? `?${query}` : ''
  }`;
  return fetchJson<SessionTailDto>(path);
}

export function fetchAgentProcesses(): Promise<AgentProcessDto[]> {
  return fetchJson<AgentProcessDto[]>('/api/processes');
}
