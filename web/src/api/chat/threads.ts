import { fetchJson } from '../http';
import type { ChatAgentDto, ChatAvailabilityDto, ChatThreadDto, ChatTurnStatusDto } from './types';

export function fetchChatAvailability(): Promise<ChatAvailabilityDto> {
  return fetchJson<ChatAvailabilityDto>('/api/chat/availability');
}

export function fetchChatAgents(): Promise<ChatAgentDto[]> {
  return fetchJson<ChatAgentDto[]>('/api/chat/agents');
}

export function fetchChatThreads(projectId: string): Promise<ChatThreadDto[]> {
  const params = new URLSearchParams({ projectId });
  return fetchJson<ChatThreadDto[]>(`/api/chat/threads?${params.toString()}`);
}

export function fetchChatTurnStatus(projectId: string): Promise<ChatTurnStatusDto> {
  const params = new URLSearchParams({ projectId });
  return fetchJson<ChatTurnStatusDto>(
    `/api/chat/turn-status?${params.toString()}`,
  );
}

export function acknowledgeChatTurn(projectId: string, sessionId: string): Promise<void> {
  const params = new URLSearchParams({ projectId, sessionId });
  return fetchJson<void>(`/api/chat/turn-status?${params.toString()}`, {
    method: 'DELETE',
  });
}

export function deleteChatThread(sessionId: string, projectId: string): Promise<void> {
  const params = new URLSearchParams({ projectId });
  return fetchJson<void>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`,
    { method: 'DELETE' },
  );
}

export function updateChatThread(
  sessionId: string,
  projectId: string,
  patch: { title?: string | null; pinned?: boolean },
): Promise<ChatThreadDto> {
  return fetchJson<ChatThreadDto>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/thread`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, ...patch }),
    },
  );
}
