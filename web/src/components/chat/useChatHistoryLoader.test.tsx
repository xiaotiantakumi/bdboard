import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionMessagesDto } from '../../api';
import { ApiError } from '../../api';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../../chatThreadStorage';
import { createProvisionalEntryMarks } from './provisionalEntry';
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
  const params = baseParamsWithoutMarks(overrides);
  // bdboard-rt6i: 仮のエントリの印は、(上書きされた場合も含め)このテストの restoredProjectsRef を読む。
  return {
    provisionalEntries: createProvisionalEntryMarks((id) => params.restoredProjectsRef.current.has(id)),
    ...params,
  };
}

function baseParamsWithoutMarks(overrides: Partial<Parameters<typeof useChatHistoryLoader>[0]> = {}) {
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
    // bdboard-7feq: 既定は「未復元・open 不明」。復元済みの挙動を見るテストが上書きする。
    openThreadIdsRef: { current: {} as Record<string, string[]> },
    restoredProjectsRef: { current: new Set<string>() },
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
    localStorage.clear();
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

  describe('bdboard-7feq: persisted open follows the live open once the project is restored', () => {
    it('first visit (no persisted entry): a successful load persists all live open threads, not just the loaded one', async () => {
      // E7 は初回訪問(エントリ無し)で全スレッドをメモリ上で開くが、永続化には何も書かない。
      // 選択スレッド sess-a の履歴ロード成功で永続化を {[sess-a]} に潰すと、リロードで
      // sess-b/sess-c が黙って閉じられる。
      fetchChatSessionMessagesMock.mockResolvedValue(payload({ sessionId: 'sess-a' }));
      const setHistoryLoadedFor = vi.fn();
      renderHook(() =>
        useChatHistoryLoader(
          baseParams({
            currentConversationKey: 'sess-a',
            currentSessionId: 'sess-a',
            openThreadIdsRef: { current: { 'project-a': ['sess-a', 'sess-b', 'sess-c'] } },
            restoredProjectsRef: { current: new Set(['project-a']) },
            setHistoryLoadedFor,
          }),
        ),
      );
      await waitFor(() => expect(setHistoryLoadedFor).toHaveBeenCalled());
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-c'],
        selectedSessionId: 'sess-a',
      });
    });

    it('keeps the live order instead of moving the loaded thread to the end', async () => {
      fetchChatSessionMessagesMock.mockResolvedValue(payload({ sessionId: 'sess-b' }));
      const setHistoryLoadedFor = vi.fn();
      renderHook(() =>
        useChatHistoryLoader(
          baseParams({
            currentConversationKey: 'sess-b',
            currentSessionId: 'sess-b',
            openThreadIdsRef: { current: { 'project-a': ['sess-a', 'sess-b', 'sess-c'] } },
            restoredProjectsRef: { current: new Set(['project-a']) },
            setHistoryLoadedFor,
          }),
        ),
      );
      await waitFor(() => expect(setHistoryLoadedFor).toHaveBeenCalled());
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-c'],
        selectedSessionId: 'sess-b',
      });
    });

    it('reads the live open at response time, not at effect start', async () => {
      let resolveFetch: (value: ChatSessionMessagesDto) => void = () => {};
      fetchChatSessionMessagesMock.mockImplementationOnce(
        () => new Promise<ChatSessionMessagesDto>((resolve) => { resolveFetch = resolve; }),
      );
      const openThreadIdsRef = { current: { 'project-a': ['sess-a'] } as Record<string, string[]> };
      const setHistoryLoadedFor = vi.fn();
      renderHook(() =>
        useChatHistoryLoader(
          baseParams({
            currentConversationKey: 'sess-a',
            currentSessionId: 'sess-a',
            openThreadIdsRef,
            restoredProjectsRef: { current: new Set(['project-a']) },
            setHistoryLoadedFor,
          }),
        ),
      );
      await waitFor(() => expect(fetchChatSessionMessagesMock).toHaveBeenCalledTimes(1));
      // fetch の in-flight 中に open が増える(別経路の書き込み)。
      openThreadIdsRef.current = { 'project-a': ['sess-a', 'sess-b'] };
      resolveFetch(payload({ sessionId: 'sess-a' }));
      await waitFor(() => expect(setHistoryLoadedFor).toHaveBeenCalled());
      expect(readPersistedChatThreads()['project-a']?.activeSessionIds).toEqual(['sess-a', 'sess-b']);
    });

    it('still includes the loaded session when it is not in the live open', async () => {
      fetchChatSessionMessagesMock.mockResolvedValue(payload({ sessionId: 'sess-z' }));
      const setHistoryLoadedFor = vi.fn();
      renderHook(() =>
        useChatHistoryLoader(
          baseParams({
            currentConversationKey: 'sess-z',
            currentSessionId: 'sess-z',
            openThreadIdsRef: { current: { 'project-a': ['sess-a', 'sess-b'] } },
            restoredProjectsRef: { current: new Set(['project-a']) },
            setHistoryLoadedFor,
          }),
        ),
      );
      await waitFor(() => expect(setHistoryLoadedFor).toHaveBeenCalled());
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-z'],
        selectedSessionId: 'sess-z',
      });
    });

    it('keeps the persisted-entry-based sum while the project is not yet restored (marker unset)', async () => {
      writePersistedChatThreadState('project-a', { activeSessionIds: ['sess-x', 'sess-a'], selectedSessionId: 'sess-x' });
      fetchChatSessionMessagesMock.mockResolvedValue(payload({ sessionId: 'sess-a' }));
      const setHistoryLoadedFor = vi.fn();
      renderHook(() =>
        useChatHistoryLoader(
          baseParams({
            currentConversationKey: 'sess-a',
            currentSessionId: 'sess-a',
            openThreadIdsRef: { current: { 'project-a': ['sess-a', 'sess-b', 'sess-c'] } },
            setHistoryLoadedFor,
          }),
        ),
      );
      await waitFor(() => expect(setHistoryLoadedFor).toHaveBeenCalled());
      // 従来どおり: 永続化済みエントリを基点に、読み込んだスレッドを末尾へ。
      expect(readPersistedChatThreads()['project-a']).toEqual({
        activeSessionIds: ['sess-x', 'sess-a'],
        selectedSessionId: 'sess-a',
      });
    });
  });

  describe('bdboard-rt6i: a load that writes the first entry of an unrestored project is a provisional entry', () => {
    async function runLoad(overrides: Partial<Parameters<typeof useChatHistoryLoader>[0]>) {
      fetchChatSessionMessagesMock.mockResolvedValue(payload({ sessionId: 'sess-a' }));
      const setHistoryLoadedFor = vi.fn();
      const params = baseParams({ currentConversationKey: 'sess-a', currentSessionId: 'sess-a', setHistoryLoadedFor, ...overrides });
      renderHook(() => useChatHistoryLoader(params));
      await waitFor(() => expect(setHistoryLoadedFor).toHaveBeenCalled());
      return params;
    }

    it('marks the project before writing the first persisted entry', async () => {
      const params = await runLoad({});
      expect(readPersistedChatThreads()['project-a']).toEqual({ activeSessionIds: ['sess-a'], selectedSessionId: 'sess-a', provisional: true });
      expect(params.provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(true);
    });

    it('does not mark a restored project: its entry follows the live open, which is the user record', async () => {
      const params = await runLoad({
        restoredProjectsRef: { current: new Set(['project-a']) },
        openThreadIdsRef: { current: { 'project-a': ['sess-a', 'sess-b'] } },
      });
      expect(params.provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(false);
    });

    it('does not mark a project that already has a persisted entry', async () => {
      writePersistedChatThreadState('project-a', { activeSessionIds: ['sess-x'], selectedSessionId: 'sess-x' });
      const params = await runLoad({});
      expect(params.provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(false);
    });
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
