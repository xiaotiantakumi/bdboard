import { fetchJson } from '../http';
import type { ChatSessionMessagesDto } from './types';

export function fetchChatSessionMessages(
  sessionId: string,
  projectId: string,
): Promise<ChatSessionMessagesDto> {
  const params = new URLSearchParams({ projectId });
  return fetchJson<ChatSessionMessagesDto>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`,
  );
}
