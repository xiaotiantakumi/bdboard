import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto } from '../../api';
import { fetchChatAgents } from '../../api';
import { useAgentListAndModelRestore } from './useAgentListAndModelRestore';

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  fetchChatAgents: vi.fn(),
}));

const agent: ChatAgentDto = {
  id: 'agent-a',
  label: 'Agent A',
  model: 'default',
  models: [
    { id: 'default', label: 'Default' },
    { id: 'cached', label: 'Cached' },
    { id: 'persisted', label: 'Persisted' },
  ],
  experimental: false,
  capability: 'bd-only',
  availability: 'available',
  supportsStreaming: false,
  supportsImages: false,
};

describe('useAgentListAndModelRestore', () => {
  beforeEach(() => vi.mocked(fetchChatAgents).mockResolvedValue([]));

  it('loads agents and chooses a default only when the current ID is empty', async () => {
    vi.mocked(fetchChatAgents).mockResolvedValue([agent]);
    const setAgents = vi.fn();
    const setSelectedAgentId = vi.fn();
    renderHook(() =>
      useAgentListAndModelRestore({
        selectedAgent: undefined,
        selectedProjectId: 'project-a',
        currentConversationKey: 'thread-a',
        threadModelIds: {},
        chatModelSelections: {},
        setAgents,
        setSelectedAgentId,
        setSelectedModelId: vi.fn(),
      }),
    );
    await waitFor(() => expect(setAgents).toHaveBeenCalledWith([agent]));
    const updater = setSelectedAgentId.mock.calls[0]?.[0];
    expect(typeof updater).toBe('function');
    expect(updater('')).toBe('agent-a');
    expect(updater('already-selected')).toBe('already-selected');
  });

  it.each([
    [{ 'thread-a': 'cached' }, {}, 'cached'],
    [{}, { 'project-a': { 'agent-a': 'persisted' } }, 'persisted'],
    [{ 'thread-a': 'stale' }, { 'project-a': { 'agent-a': 'stale' } }, 'default'],
    [{ 'thread-a': 'cached' }, { 'project-a': { 'agent-a': 'persisted' } }, 'cached'],
    [{ 'thread-a': 'stale' }, { 'project-a': { 'agent-a': 'persisted' } }, 'persisted'],
  ])('restores model in cache, persisted, default order', async (threadModelIds, chatModelSelections, expected) => {
    const setSelectedModelId = vi.fn();
    const { rerender } = renderHook(
      ({ selectedAgent }: { selectedAgent: ChatAgentDto | undefined }) =>
        useAgentListAndModelRestore({
          selectedAgent,
          selectedProjectId: 'project-a',
          currentConversationKey: 'thread-a',
          threadModelIds,
          chatModelSelections,
          setAgents: vi.fn(),
          setSelectedAgentId: vi.fn(),
          setSelectedModelId,
        }),
      { initialProps: { selectedAgent: undefined as ChatAgentDto | undefined } },
    );
    await act(async () => rerender({ selectedAgent: agent }));
    await waitFor(() => expect(setSelectedModelId).toHaveBeenLastCalledWith(expected));
  });
});
