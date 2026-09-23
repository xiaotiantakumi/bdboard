import { fetchJson } from '../http';
import type { AdoptChatSessionResponseDto, DiscoveredChatSessionsDto } from './types';

export function fetchDiscoveredChatSessions(
  projectId: string,
): Promise<DiscoveredChatSessionsDto> {
  return fetchJson<DiscoveredChatSessionsDto>(
    `/api/chat/projects/${encodeURIComponent(projectId)}/discovered-sessions`,
  );
}

export function adoptDiscoveredChatSession(
  projectId: string,
  sessionId: string,
  agentId?: string,
): Promise<AdoptChatSessionResponseDto> {
  return fetchJson<AdoptChatSessionResponseDto>(
    `/api/chat/projects/${encodeURIComponent(projectId)}/discovered-sessions/${encodeURIComponent(sessionId)}/adopt`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(agentId !== undefined ? { agentId } : {}),
    },
  );
}
