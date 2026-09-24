import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionMessagesDto } from '../../api';
import { ApiError } from '../../api';
import { useChatHistoryLoader } from './useChatHistoryLoader';
import type { ChatConversationEntry } from './useChatConversationsState';

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  fetchChatSessionMessages: vi.fn(),
}));

import { fetchChatSessionMessages } from '../../api';

const fetchChatSessionMessagesMock = vi.mocked(fetchChatSessionMessages);

function payload(overrides: Partial<ChatSessionMessagesDto>): ChatSessionMessagesDto {
  return {
    sessionId: 'sess-1',
    agentId: 'agent-a',
    messages: [],
    ...overrides,
  };
}

function baseParams(overrides: Partial<Parameters<typeof useChatHistoryLoader>[0]> = {}) {
  return {
    selectedProjectId: 'project-a',
    currentConversationKey: 'sess-1',
    currentSessionId: 'sess-1',
    conversations: {} as Record<string, ChatConversationEntry>,
    historyLoadedFor: {},
    setConversations: vi.fn(),
    setHistoryLoadedFor: vi.fn(),
    setLoadingHistoryFor: vi.fn(),
    setThreadModelIds: vi.fn(),
    historyRequestIdRef: { current: 0 },
    conversationsRef: { current: {} as Record<string, ChatConversationEntry> },
    setSelectedAgentId: vi.fn(),
    unresolvedSends: {},
    clearUnresolvedSend: vi.fn(),
    onSessionGone: vi.fn(),
    ...overrides,
  };
}

describe('useChatHistoryLoader: history fetch effect', () => {
  beforeEach(() => {
    fetchChatSessionMessagesMock.mockReset();
  });

  it('loads history and applies the restored agent/model on success', async () => {
    fetchChatSessionMessagesMock.mockResolvedValue(
      payload({ agentId: 'agent-b', model: 'model-x' }),
    );
    const setConversations = vi.fn();
    const setSelectedAgentId = vi.fn();
    const setThreadModelIds = vi.fn();
    const setHistoryLoadedFor = vi.fn();
    renderHook(() =>
      useChatHistoryLoader(
        baseParams({ setConversations, setSelectedAgentId, setThreadModelIds, setHistoryLoadedFor }),
      ),
    );
    await waitFor(() => expect(setConversations).toHaveBeenCalled());
    expect(setSelectedAgentId).toHaveBeenCalledWith('agent-b');
    const modelUpdater = setThreadModelIds.mock.calls[0]?.[0];
    expect(modelUpdater({})).toEqual({ 'sess-1': 'model-x' });
    await waitFor(() =>
      expect(setHistoryLoadedFor).toHaveBeenCalledWith(expect.any(Function)),
    );
  });

  it('calls onSessionGone for a 404 (dead session) but not for other errors', async () => {
    fetchChatSessionMessagesMock.mockRejectedValueOnce(new ApiError(404, 'not found'));
    const onSessionGone = vi.fn();
    renderHook(() => useChatHistoryLoader(baseParams({ onSessionGone })));
    await waitFor(() => expect(onSessionGone).toHaveBeenCalledWith('sess-1'));
  });

  it('calls onSessionGone for a 400 "unknown chat session" but not other 400s', async () => {
    fetchChatSessionMessagesMock.mockRejectedValueOnce(
      new ApiError(400, 'bad request', { errorMessage: 'unknown chat session' }),
    );
    const onSessionGone = vi.fn();
    const { unmount } = renderHook(() => useChatHistoryLoader(baseParams({ onSessionGone })));
    await waitFor(() => expect(onSessionGone).toHaveBeenCalledWith('sess-1'));
    unmount();

    fetchChatSessionMessagesMock.mockReset();
    fetchChatSessionMessagesMock.mockRejectedValueOnce(
      new ApiError(400, 'bad request', { errorMessage: 'something else' }),
    );
    const onSessionGoneOther = vi.fn();
    renderHook(() =>
      useChatHistoryLoader(
        baseParams({ currentConversationKey: 'sess-2', currentSessionId: 'sess-2', onSessionGone: onSessionGoneOther }),
      ),
    );
    await waitFor(() => expect(fetchChatSessionMessagesMock).toHaveBeenCalled());
    expect(onSessionGoneOther).not.toHaveBeenCalled();
  });

  it('does not call onSessionGone for a 500 or a non-ApiError failure', async () => {
    fetchChatSessionMessagesMock.mockRejectedValueOnce(new ApiError(500, 'server error'));
    const onSessionGone = vi.fn();
    const { unmount } = renderHook(() => useChatHistoryLoader(baseParams({ onSessionGone })));
    await waitFor(() => expect(fetchChatSessionMessagesMock).toHaveBeenCalledTimes(1));
    expect(onSessionGone).not.toHaveBeenCalled();
    unmount();

    fetchChatSessionMessagesMock.mockRejectedValueOnce(new Error('network down'));
    const onSessionGoneNetwork = vi.fn();
    renderHook(() =>
      useChatHistoryLoader(
        baseParams({ currentConversationKey: 'sess-3', currentSessionId: 'sess-3', onSessionGone: onSessionGoneNetwork }),
      ),
    );
    await waitFor(() => expect(fetchChatSessionMessagesMock).toHaveBeenCalledTimes(2));
    expect(onSessionGoneNetwork).not.toHaveBeenCalled();
  });

  it('suppresses onSessionGone when the conversation key changed before the dead-session response arrived', async () => {
    let rejectFirst: (error: unknown) => void = () => {};
    const firstPromise = new Promise<ChatSessionMessagesDto>((_resolve, reject) => {
      rejectFirst = reject;
    });
    fetchChatSessionMessagesMock.mockImplementationOnce(() => firstPromise);
    // sess-2 側の fetch はこのテストでは解決させない(邪魔をさせないだけ)。
    fetchChatSessionMessagesMock.mockImplementationOnce(() => new Promise(() => {}));

    const onSessionGone = vi.fn();
    // historyRequestIdRef は再描画をまたいで同じ参照を共有させる — cleanup が
    // これを進める様子をそのまま観測するため。
    const historyRequestIdRef = { current: 0 };
    const { rerender } = renderHook(
      (props: { key: string }) =>
        useChatHistoryLoader(
          baseParams({
            currentConversationKey: props.key,
            currentSessionId: props.key,
            historyRequestIdRef,
            onSessionGone,
          }),
        ),
      { initialProps: { key: 'sess-1' } },
    );
    await waitFor(() => expect(fetchChatSessionMessagesMock).toHaveBeenCalledTimes(1));

    // 会話キーが切り替わる — 前の effect の cleanup が historyRequestIdRef を
    // 進め、「もう今のリクエストではない」印を付ける。
    rerender({ key: 'sess-2' });
    await waitFor(() => expect(fetchChatSessionMessagesMock).toHaveBeenCalledTimes(2));
    expect(historyRequestIdRef.current).toBe(1);

    // 古い(sess-1 の)リクエストが遅れて 404 を返しても、requestId ガードで
    // 弾かれて prune には繋がらない。
    rejectFirst(new ApiError(404, 'not found'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSessionGone).not.toHaveBeenCalled();
  });
});

describe('useChatHistoryLoader: unresolved-send retry effect', () => {
  beforeEach(() => {
    fetchChatSessionMessagesMock.mockReset();
  });

  it('does nothing when the current session has no unresolved send', () => {
    renderHook(() =>
      useChatHistoryLoader(
        baseParams({
          currentConversationKey: 'sess-1',
          conversations: { 'sess-1': { messages: [{ id: '1' } as never], sessionId: 'sess-1' } },
          historyLoadedFor: { 'sess-1': true },
          unresolvedSends: {},
        }),
      ),
    );
    expect(fetchChatSessionMessagesMock).not.toHaveBeenCalled();
  });

  it('retries and clears the unresolved mark when the server tail grew', async () => {
    fetchChatSessionMessagesMock.mockResolvedValue(
      payload({
        messages: [
          { role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:01.000Z' },
          { role: 'assistant', content: 'hello', createdAt: '2026-01-01T00:00:02.000Z' },
        ],
      }),
    );
    const setConversations = vi.fn();
    const setHistoryLoadedFor = vi.fn();
    const clearUnresolvedSend = vi.fn();
    renderHook(() =>
      useChatHistoryLoader(
        baseParams({
          currentConversationKey: 'sess-1',
          conversations: { 'sess-1': { messages: [{ id: '1' } as never], sessionId: 'sess-1' } },
          historyLoadedFor: { 'sess-1': true },
          unresolvedSends: { 'sess-1': true },
          conversationsRef: {
            current: { 'sess-1': { messages: [{ id: '1' } as never], sessionId: 'sess-1' } },
          },
          setConversations,
          setHistoryLoadedFor,
          clearUnresolvedSend,
        }),
      ),
    );
    await waitFor(() => expect(clearUnresolvedSend).toHaveBeenCalledWith('sess-1'));
    expect(setConversations).toHaveBeenCalled();
    expect(setHistoryLoadedFor).toHaveBeenCalled();
  });
});
