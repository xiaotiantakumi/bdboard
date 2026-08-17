import { describe, expect, it } from 'vitest';
import type { ChatAgentPort } from '../ports/chat-agent.js';
import { createChatAgentRegistry } from './chat-agent-registry.js';

function fakeAgent(
  id: string,
  options: {
    readonly experimental?: boolean;
  } = {},
): ChatAgentPort {
  const { experimental = false } = options;
  return {
    descriptor: {
      id,
      label: id,
      models: [{ id: 'sonnet', label: 'Sonnet' }],
      experimental,
      capability: 'bd-only',
    },
    checkAvailability: async () => 'available' as const,
    sendMessage: async () => ({
      reply: 'ok',
      sessionId: 'sess-1',
      failedTools: [],
      agentId: id,
    }),
  };
}

describe('createChatAgentRegistry', () => {
  it('returns empty arrays when no agents are registered', () => {
    const registry = createChatAgentRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.defaultAgent()).toBeUndefined();
  });

  it('places experimental agents after non-experimental ones', () => {
    const registry = createChatAgentRegistry();
    const stable = fakeAgent('stable', { experimental: false });
    const experimental = fakeAgent('experimental', { experimental: true });

    registry.register(experimental);
    registry.register(stable);

    expect(registry.list().map((agent) => agent.descriptor.id)).toEqual([
      'stable',
      'experimental',
    ]);
    expect(registry.defaultAgent()?.descriptor.id).toBe('stable');
  });

  it('keeps experimental agents last even when registered later', () => {
    const registry = createChatAgentRegistry();
    registry.register(fakeAgent('exp-a', { experimental: true }));
    registry.register(fakeAgent('stable-b', { experimental: false }));

    expect(registry.list().map((agent) => agent.descriptor.id)).toEqual([
      'stable-b',
      'exp-a',
    ]);
  });

  it('sorts within the same category by id ascending', () => {
    const registry = createChatAgentRegistry();
    registry.register(fakeAgent('z-agent'));
    registry.register(fakeAgent('a-agent'));
    registry.register(fakeAgent('m-agent'));

    expect(registry.list().map((agent) => agent.descriptor.id)).toEqual([
      'a-agent',
      'm-agent',
      'z-agent',
    ]);
  });

  it('replaces an agent when the same id is registered again', () => {
    const registry = createChatAgentRegistry();
    const first = fakeAgent('same-id');
    const second = fakeAgent('same-id');

    registry.register(first);
    registry.register(second);

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]).toBe(second);
    expect(registry.get('same-id')).toBe(second);
  });

  it('returns a new array on each list call', () => {
    const registry = createChatAgentRegistry();
    registry.register(fakeAgent('a'));

    const first = registry.list();
    const second = registry.list();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
