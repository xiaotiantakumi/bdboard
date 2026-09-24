import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { ChatAgentDto } from '../../api';

export function useAgentFromConversationSync(params: {
  currentSessionId: string | undefined;
  conversations: Record<string, { messages: unknown[]; sessionId?: string; agentId?: string }>;
  agents: readonly ChatAgentDto[];
  setSelectedAgentId: Dispatch<SetStateAction<string>>;
}): void {
  const { currentSessionId, conversations, agents, setSelectedAgentId } = params;
  useEffect(() => {
    if (currentSessionId === undefined) return;
    const conversationAgentId = conversations[currentSessionId]?.agentId;
    if (
      conversationAgentId !== undefined &&
      conversationAgentId !== '' &&
      agents.some((agent) => agent.id === conversationAgentId)
    ) {
      setSelectedAgentId(conversationAgentId);
    }
  }, [currentSessionId, conversations, agents, setSelectedAgentId]);
}
