import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionMessagesDto, ChatThreadDto } from '../../api';
import { readPersistedChatThreads } from '../../chatThreadStorage';
import { useChatSessionLifecycle, type UseChatSessionLifecycleParams } from './useChatSessionLifecycle';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, fetchChatThreads: vi.fn(() => Promise.resolve<ChatThreadDto[]>([])) };
});

import { fetchChatThreads } from '../../api';

const fetchChatThreadsMock = vi.mocked(fetchChatThreads);

function thread(sessionId: string, title: string | null = null): ChatThreadDto {
  return { sessionId, agentId: 'agent-a', title, pinned: false, updatedAt: '2026-01-01T00:00:00.000Z' };
}

/** vi.fn に渡された最後の引数を、関数型更新なら prev に適用し、値ならそのまま返す。 */
function lastUpdate<T>(setter: ReturnType<typeof vi.fn>, prev: T): T {
  const arg = setter.mock.calls.at(-1)![0] as T | ((value: T) => T);
  return typeof arg === 'function' ? (arg as (value: T) => T)(prev) : arg;
}

function setup(overrides: Partial<UseChatSessionLifecycleParams> = {}) {
  const params: UseChatSessionLifecycleParams = {
    selectedProjectId: 'project-a',
    selectedThreadIdsRef: { current: {} },
    setSelectedThreadIds: vi.fn(),
    historyRequestIdRef: { current: 0 },
    setConversations: vi.fn(),
    setHistoryLoadedFor: vi.fn(),
    setLoadingHistoryFor: vi.fn(),
    setThreadModelIds: vi.fn(),
    openThreads: [],
    openThreadIdsRef: { current: {} },
    setThreadLists: vi.fn(),
    setOpenThreadIds: vi.fn(),
    setSelectedAgentId: vi.fn(),
    cancelThreadConfirmDelete: vi.fn(),
    advanceDraftNonceAfterSessionGone: vi.fn(),
    ...overrides,
  };
  const hook = renderHook((props: UseChatSessionLifecycleParams) => useChatSessionLifecycle(props), {
    initialProps: params,
  });
  return { ...hook, params };
}

const RECOVERED: ChatSessionMessagesDto = {
  sessionId: 'sess-rec',
  agentId: 'agent-b',
  model: 'model-2',
  messages: [{ role: 'assistant', content: 'recovered', createdAt: '2026-08-18T12:00:00.000Z' }],
};

describe('useChatSessionLifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchChatThreadsMock.mockReset();
    fetchChatThreadsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('applyRecoveredTurn', () => {
    it('opens, selects and hydrates the recovered session when nothing is selected', () => {
      const threads = [thread('sess-rec', 'recovered title')];
      const { result, params } = setup({ openThreadIdsRef: { current: { 'project-a': ['sess-old'] } } });
      act(() => result.current.applyRecoveredTurn(threads, RECOVERED));

      expect(lastUpdate(params.setThreadLists as ReturnType<typeof vi.fn>, {})).toEqual({ 'project-a': threads });
      expect(
        lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, { 'project-a': ['stale'], other: ['x'] }),
      ).toEqual({ 'project-a': ['sess-old', 'sess-rec'], other: ['x'] });
      expect(lastUpdate(params.setConversations as ReturnType<typeof vi.fn>, {})).toEqual({
        'sess-rec': {
          sessionId: 'sess-rec',
          agentId: 'agent-b',
          messages: [{ role: 'assistant', text: 'recovered', at: Date.parse('2026-08-18T12:00:00.000Z') }],
        },
      });
      expect(lastUpdate(params.setHistoryLoadedFor as ReturnType<typeof vi.fn>, {})).toEqual({ 'sess-rec': true });
      expect(lastUpdate(params.setThreadModelIds as ReturnType<typeof vi.fn>, { keep: 'm' })).toEqual({
        keep: 'm',
        'sess-rec': 'model-2',
      });
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-rec',
      });
      expect(params.setSelectedAgentId).toHaveBeenCalledWith('agent-b');
      expect(readPersistedChatThreads()).toEqual({
        'project-a': { activeSessionIds: ['sess-old', 'sess-rec'], selectedSessionId: 'sess-rec' },
      });
    });

    it('keeps an existing selection, moves an already-open id to the end, and leaves the agent alone', () => {
      const { result, params } = setup({
        selectedThreadIdsRef: { current: { 'project-a': 'sess-1' } },
        openThreadIdsRef: { current: { 'project-a': ['sess-rec', 'sess-1'] } },
      });
      act(() => result.current.applyRecoveredTurn([], RECOVERED));

      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-1', 'sess-rec'],
      });
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-1',
      });
      expect(params.setSelectedAgentId).not.toHaveBeenCalled();
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-1', 'sess-rec'],
        selectedSessionId: 'sess-1',
      });
    });

    it('does not write a model for a missing or empty model, nor an agent for an empty agentId', () => {
      const { result, params } = setup();
      act(() => result.current.applyRecoveredTurn([], { ...RECOVERED, model: undefined, agentId: '' }));
      act(() => result.current.applyRecoveredTurn([], { ...RECOVERED, model: '' }));
      expect(params.setThreadModelIds).not.toHaveBeenCalled();
      expect(params.setSelectedAgentId).toHaveBeenCalledTimes(1);
    });

    it('keeps the callback identity across renders until the project changes', () => {
      const { result, rerender, params } = setup();
      const first = result.current.applyRecoveredTurn;
      rerender({ ...params, openThreads: ['sess-x'] });
      expect(result.current.applyRecoveredTurn).toBe(first);
      rerender({ ...params, selectedProjectId: 'project-b' });
      expect(result.current.applyRecoveredTurn).not.toBe(first);
    });
  });

  describe('handleHistorySessionGone', () => {
    it('prunes the dead selected session, clears and persists the selection, and advances the draft nonce', () => {
      const { result, params } = setup({
        selectedThreadIdsRef: { current: { 'project-a': 'sess-dead' } },
        openThreadIdsRef: { current: { 'project-a': ['sess-live', 'sess-dead'] } },
      });
      act(() => result.current.handleHistorySessionGone('sess-dead'));

      expect(
        lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, { 'project-a': ['sess-live', 'sess-dead'] }),
      ).toEqual({ 'project-a': ['sess-live'] });
      expect(
        lastUpdate(params.setThreadLists as ReturnType<typeof vi.fn>, {
          'project-a': [thread('sess-live'), thread('sess-dead')],
        }),
      ).toEqual({ 'project-a': [thread('sess-live')] });
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, { 'project-a': 'sess-dead' })).toEqual(
        { 'project-a': undefined },
      );
      const unchanged = { 'project-a': 'sess-other' };
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, unchanged)).toBe(unchanged);
      expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['sess-live'] });
      expect(params.advanceDraftNonceAfterSessionGone).toHaveBeenCalledWith('project-a');
    });

    it('only prunes when the dead session is not the selected one', () => {
      const { result, params } = setup({
        selectedThreadIdsRef: { current: { 'project-a': 'sess-live' } },
        openThreadIdsRef: { current: { 'project-a': ['sess-live', 'sess-dead'] } },
      });
      act(() => result.current.handleHistorySessionGone('sess-dead'));

      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({ 'project-a': [] });
      expect(params.setThreadLists).toHaveBeenCalledTimes(1);
      expect(params.setSelectedThreadIds).not.toHaveBeenCalled();
      expect(params.advanceDraftNonceAfterSessionGone).not.toHaveBeenCalled();
      expect(readPersistedChatThreads()).toEqual({});
    });

    it('keeps the callback identity across renders, so E12 does not restart its fetch', () => {
      const { result, rerender, params } = setup();
      const first = result.current.handleHistorySessionGone;
      rerender({ ...params, openThreads: ['sess-x'], selectedThreadIdsRef: { current: {} } });
      expect(result.current.handleHistorySessionGone).toBe(first);
    });
  });

  describe('handleResumeDiscoveredSession', () => {
    it('seeds the conversation, opens and selects the session, and refreshes the thread list', async () => {
      vi.useFakeTimers({ now: 1_000, toFake: ['Date'] });
      const refreshed = [thread('sess-new', 'refreshed')];
      fetchChatThreadsMock.mockResolvedValue(refreshed);
      const historyRequestIdRef = { current: 4 };
      const { result, params } = setup({ historyRequestIdRef, openThreads: ['sess-1'] });
      act(() =>
        result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', [
          { role: 'user', text: 'with time', timestamp: '2026-08-16T11:00:00.000Z' },
          { role: 'assistant', text: 'without time' },
        ]),
      );

      expect(historyRequestIdRef.current).toBe(5);
      expect(params.setSelectedAgentId).toHaveBeenCalledWith('agent-b');
      expect(lastUpdate(params.setConversations as ReturnType<typeof vi.fn>, {})).toEqual({
        'sess-new': {
          sessionId: 'sess-new',
          agentId: 'agent-b',
          messages: [
            { role: 'user', text: 'with time', at: Date.parse('2026-08-16T11:00:00.000Z') },
            { role: 'assistant', text: 'without time', at: 1_001 },
          ],
        },
      });
      expect(lastUpdate(params.setHistoryLoadedFor as ReturnType<typeof vi.fn>, {})).toEqual({ 'sess-new': true });
      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, { other: ['x'] })).toEqual({
        other: ['x'],
        'project-a': ['sess-1', 'sess-new'],
      });
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-1', 'sess-new'],
        selectedSessionId: 'sess-new',
      });
      expect(lastUpdate(params.setSelectedThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': 'sess-new',
      });
      expect(params.cancelThreadConfirmDelete).toHaveBeenCalledOnce();
      expect(lastUpdate(params.setLoadingHistoryFor as ReturnType<typeof vi.fn>, 'sess-new')).toBeNull();
      expect(lastUpdate(params.setLoadingHistoryFor as ReturnType<typeof vi.fn>, 'sess-other')).toBe('sess-other');
      expect(fetchChatThreadsMock).toHaveBeenCalledWith('project-a');
      vi.useRealTimers();
      await waitFor(() => {
        expect(lastUpdate(params.setThreadLists as ReturnType<typeof vi.fn>, {})).toEqual({ 'project-a': refreshed });
      });
    });

    it('does not duplicate an already-open session', () => {
      const { result, params } = setup({ openThreads: ['sess-new', 'sess-1'] });
      act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
      expect(lastUpdate(params.setOpenThreadIds as ReturnType<typeof vi.fn>, {})).toEqual({
        'project-a': ['sess-new', 'sess-1'],
      });
    });

    it('falls back to an explanatory note when there are no seed messages', () => {
      const { result, params } = setup();
      act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
      const conversations = lastUpdate(params.setConversations as ReturnType<typeof vi.fn>, {}) as Record<
        string,
        { messages: { role: string; text: string }[] }
      >;
      expect(conversations['sess-new'].messages).toEqual([
        expect.objectContaining({
          role: 'assistant',
          text: 'このCLIセッションの直近の会話をここに表示できませんでした。続きから会話できます。',
        }),
      ]);
    });

    it('swallows a failed thread-list refresh', async () => {
      fetchChatThreadsMock.mockRejectedValue(new Error('threads down'));
      const { result, params } = setup();
      act(() => result.current.handleResumeDiscoveredSession('sess-new', 'agent-b', []));
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
      await act(async () => {
        await Promise.resolve();
      });
      expect(params.setThreadLists).not.toHaveBeenCalled();
    });
  });
});
