import { compareStrings } from '../../domain/compare.js';
import type { ChatAgentPort } from '../ports/chat-agent.js';

export interface ChatAgentRegistry {
  register(agent: ChatAgentPort): void;
  get(id: string): ChatAgentPort | undefined;
  list(): readonly ChatAgentPort[];
  defaultAgent(): ChatAgentPort | undefined;
}

function sortAgents(agents: readonly ChatAgentPort[]): ChatAgentPort[] {
  const stable = agents.filter((agent) => !agent.descriptor.experimental);
  const experimental = agents.filter((agent) => agent.descriptor.experimental);

  stable.sort((a, b) => compareStrings(a.descriptor.id, b.descriptor.id));
  experimental.sort((a, b) => compareStrings(a.descriptor.id, b.descriptor.id));

  return [...stable, ...experimental];
}

export function createChatAgentRegistry(): ChatAgentRegistry {
  const agents = new Map<string, ChatAgentPort>();

  return {
    register(agent: ChatAgentPort): void {
      agents.set(agent.descriptor.id, agent);
    },

    get(id: string): ChatAgentPort | undefined {
      return agents.get(id);
    },

    list(): readonly ChatAgentPort[] {
      return sortAgents([...agents.values()]);
    },

    defaultAgent(): ChatAgentPort | undefined {
      const listed = sortAgents([...agents.values()]);
      return listed[0];
    },
  };
}
