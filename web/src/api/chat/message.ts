import { fetchJson } from '../http';
import type { ChatMessageRequest, ChatMessageResponseDto } from './types';

export function postChatMessage(
  body: ChatMessageRequest,
  signal?: AbortSignal,
): Promise<ChatMessageResponseDto> {
  const payload: ChatMessageRequest = {
    projectId: body.projectId,
    message: body.message,
  };
  if (body.sessionId !== undefined) {
    payload.sessionId = body.sessionId;
  }
  if (body.agentId !== undefined) {
    payload.agentId = body.agentId;
  }
  if (body.model !== undefined) {
    payload.model = body.model;
  }
  if (body.images !== undefined) {
    payload.images = body.images;
  }
  return fetchJson<ChatMessageResponseDto>('/api/chat/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...(signal !== undefined ? { signal } : {}),
  });
}
