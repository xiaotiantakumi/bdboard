import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto } from '../../api';
import { useAgentFromConversationSync } from './useAgentFromConversationSync';

const agents = [
  { id: 'agent-a' } as ChatAgentDto,
  { id: 'agent-b' } as ChatAgentDto,
];

describe('useAgentFromConversationSync', () => {
  it('does nothing without a current session', () => {
    const setSelectedAgentId = vi.fn();
    renderHook(() =>
      useAgentFromConversationSync({
        currentSessionId: undefined,
        conversations: {},
        agents,
        setSelectedAgentId,
      }),
    );
    expect(setSelectedAgentId).not.toHaveBeenCalled();
  });

  it('syncs only agent IDs present in the loaded agent list', () => {
    const setSelectedAgentId = vi.fn();
    const { rerender } = renderHook(
      ({ agentId }: { agentId: string }) =>
        useAgentFromConversationSync({
          currentSessionId: 'session-a',
          conversations: { 'session-a': { messages: [], agentId } },
          agents,
          setSelectedAgentId,
        }),
      { initialProps: { agentId: 'missing' } },
    );
    expect(setSelectedAgentId).not.toHaveBeenCalled();
    rerender({ agentId: '' });
    expect(setSelectedAgentId).not.toHaveBeenCalled();
    rerender({ agentId: 'agent-b' });
    expect(setSelectedAgentId).toHaveBeenCalledWith('agent-b');
  });
});
