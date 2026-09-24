import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto } from '../../api';
import { useChatAgentModelState } from './useChatAgentModelState';

const agent: ChatAgentDto = {
  id: 'agent-a',
  label: 'Agent A',
  model: 'fast',
  models: [
    { id: 'fast', label: 'Fast' },
    { id: 'quality', label: 'Quality' },
  ],
  experimental: false,
  capability: 'bd-only',
  availability: 'available',
  supportsStreaming: false,
  supportsImages: false,
};

describe('useChatAgentModelState', () => {
  it('starts empty and computes selectable and effective model values', () => {
    const { result } = renderHook(() =>
      useChatAgentModelState({
        selectedProjectId: 'project-a',
        currentConversationKey: 'thread-a',
        threadModelIds: {},
        setThreadModelIds: vi.fn(),
      }),
    );
    expect(result.current.agents).toEqual([]);
    expect(result.current.selectedAgentId).toBe('');
    expect(result.current.selectedModelId).toBe('');
    expect(result.current.showModelSelect).toBe(false);
    expect(result.current.effectiveModelId).toBe('');
    act(() => {
      result.current.setAgents([agent]);
      result.current.setSelectedAgentId(agent.id);
    });
    expect(result.current.showModelSelect).toBe(true);
    expect(result.current.effectiveModelId).toBe('fast');
    act(() => result.current.setSelectedModelId('quality'));
    expect(result.current.effectiveModelId).toBe('quality');
    act(() => result.current.setSelectedModelId('stale-model'));
    expect(result.current.effectiveModelId).toBe('fast');
  });

  it('writes the thread cache and persists only when agent and project are selected', () => {
    const setThreadModelIds = vi.fn();
    const { result } = renderHook(() =>
      useChatAgentModelState({
        selectedProjectId: '',
        currentConversationKey: 'thread-a',
        threadModelIds: {},
        setThreadModelIds,
      }),
    );
    act(() => result.current.handleModelChange('quality'));
    expect(result.current.selectedModelId).toBe('quality');
    expect(setThreadModelIds).toHaveBeenCalledOnce();
    expect(localStorage.getItem('bdboard.ui.chatModelSelections')).toBeNull();
  });

  it('persists the selection for a nonempty project and agent', () => {
    const { result } = renderHook(() =>
      useChatAgentModelState({
        selectedProjectId: 'project-a',
        currentConversationKey: 'thread-a',
        threadModelIds: {},
        setThreadModelIds: vi.fn(),
      }),
    );
    act(() => {
      result.current.setAgents([agent]);
      result.current.setSelectedAgentId(agent.id);
    });
    act(() => result.current.handleModelChange('quality'));
    expect(JSON.parse(localStorage.getItem('bdboard.ui.chatModelSelections') ?? '{}')).toEqual({
      'project-a': { 'agent-a': 'quality' },
    });
  });

  it('keeps setters and model handler references stable across unrelated renders', () => {
    const setThreadModelIds = vi.fn();
    const { result, rerender } = renderHook(
      ({ unused }: { unused: number }) => {
        void unused;
        return useChatAgentModelState({
          selectedProjectId: 'project-a',
          currentConversationKey: 'thread-a',
          threadModelIds: {},
          setThreadModelIds,
        });
      },
      { initialProps: { unused: 0 } },
    );
    const setter = result.current.setSelectedAgentId;
    const handler = result.current.handleModelChange;
    rerender({ unused: 1 });
    expect(result.current.setSelectedAgentId).toBe(setter);
    expect(result.current.handleModelChange).toBe(handler);
  });
});
