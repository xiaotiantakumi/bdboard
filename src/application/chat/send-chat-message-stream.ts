import type { ChatAgentPort, ChatTurnRequest } from '../ports/chat-agent.js';
import {
  createChatTurnRequest,
  resolveChatTurnAgent,
  type SendChatMessageDeps,
  type SendChatMessageFailure,
  type SendChatMessageInput,
} from './send-chat-message.js';

export interface ChatStreamTurnHandle {
  readonly agent: ChatAgentPort;
  readonly turnRequest: ChatTurnRequest;
  readonly release: () => void;
}

export type ResolveChatStreamTurnResult =
  | { readonly ok: true; readonly handle: ChatStreamTurnHandle }
  | { readonly ok: false; readonly failure: SendChatMessageFailure };

export async function resolveChatStreamTurn(
  deps: SendChatMessageDeps,
  input: SendChatMessageInput,
): Promise<ResolveChatStreamTurnResult> {
  const resolved = await resolveChatTurnAgent(deps, input);
  if (!resolved.ok) return resolved;
  if (resolved.agent.sendMessageStream === undefined) {
    resolved.release();
    return { ok: false, failure: { kind: 'streaming-not-supported' } };
  }
  return {
    ok: true,
    handle: {
      agent: resolved.agent,
      turnRequest: createChatTurnRequest(resolved, input),
      release: resolved.release,
    },
  };
}
