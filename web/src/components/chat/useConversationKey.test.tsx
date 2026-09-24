import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useConversationKey } from './useConversationKey';

describe('useConversationKey', () => {
  it('falls back to a draft key when no thread is selected for the project', () => {
    const { result } = renderHook(() => useConversationKey('project-a'));
    expect(result.current.currentSessionId).toBeUndefined();
    expect(result.current.currentConversationKey).toBe('new:project-a:0');
    expect(result.current.currentConversationKeyRef.current).toBe('new:project-a:0');
    expect(result.current.selectedThreadIdsRef.current).toEqual({});
    expect(result.current.draftNoncesRef.current).toEqual({});
  });

  it('bumps the draft key when the nonce for the project increases', () => {
    const { result } = renderHook(() => useConversationKey('project-a'));
    act(() => {
      result.current.setDraftNonces((prev) => ({ ...prev, 'project-a': 1 }));
    });
    expect(result.current.currentConversationKey).toBe('new:project-a:1');
    expect(result.current.currentConversationKeyRef.current).toBe('new:project-a:1');
    expect(result.current.draftNoncesRef.current).toEqual({ 'project-a': 1 });
  });

  it('prefers the selected session id over the draft key once a thread is selected', () => {
    const { result } = renderHook(() => useConversationKey('project-a'));
    act(() => {
      result.current.setSelectedThreadIds((prev) => ({ ...prev, 'project-a': 'sess-1' }));
    });
    expect(result.current.currentSessionId).toBe('sess-1');
    expect(result.current.currentConversationKey).toBe('sess-1');
    expect(result.current.currentConversationKeyRef.current).toBe('sess-1');
    expect(result.current.selectedThreadIdsRef.current).toEqual({ 'project-a': 'sess-1' });
  });

  it('keeps each project isolated', () => {
    const { result } = renderHook(() => useConversationKey('project-a'));
    act(() => {
      result.current.setSelectedThreadIds((prev) => ({ ...prev, 'project-b': 'sess-2' }));
    });
    // project-a is untouched, so it still falls back to its own draft key.
    expect(result.current.currentSessionId).toBeUndefined();
    expect(result.current.currentConversationKey).toBe('new:project-a:0');
  });

  it('recomputes the conversation key when selectedProjectId changes', () => {
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useConversationKey(projectId),
      { initialProps: { projectId: 'project-a' } },
    );
    act(() => {
      result.current.setSelectedThreadIds((prev) => ({ ...prev, 'project-a': 'sess-1' }));
    });
    expect(result.current.currentConversationKey).toBe('sess-1');
    rerender({ projectId: 'project-b' });
    expect(result.current.currentSessionId).toBeUndefined();
    expect(result.current.currentConversationKey).toBe('new:project-b:0');
  });
});
