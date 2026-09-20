import type { ChatTurnResult } from '../../../application/ports/chat-agent.js';
import { truncate } from '../../../domain/text.js';

const MAX_REPLY_CHARS = 20_000;

export function buildTurnResult(
  parsed: Omit<ChatTurnResult, 'agentId'>,
  agentId: string,
  fallbackModel: string | undefined,
): ChatTurnResult {
  const model = parsed.model ?? fallbackModel;
  return {
    reply: truncate(parsed.reply, MAX_REPLY_CHARS),
    sessionId: parsed.sessionId,
    failedTools: parsed.failedTools,
    agentId,
    ...(model !== undefined ? { model } : {}),
    ...(parsed.agentWarnings !== undefined && parsed.agentWarnings.length > 0
      ? { agentWarnings: parsed.agentWarnings }
      : {}),
  };
}
