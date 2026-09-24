// bdboard-x4mv: useTurnStatusRecovery(turn-status 回収 = 設計書 §1c の E8)の
// request-id の扱いを直接確かめる。generation の bump(ストリームの abort など)で
// effect が張り直されても、スレッド一覧の request-id は進めない(進めると、同時に
// 始まった useThreadListSync の一覧 fetch を握りつぶす)。進めるのは回収した
// ターンを hydrate する直前だけで、そこでは従来どおり古い一覧応答を無効化する。
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionMessagesDto, ChatThreadDto, ChatTurnStatusDto } from '../../api';
import { useTurnStatusRecovery, type DetachedTurnSend } from './useTurnStatusRecovery';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    acknowledgeChatTurn: vi.fn(),
    fetchChatSessionMessages: vi.fn(),
    fetchChatThreads: vi.fn(),
    fetchChatTurnStatus: vi.fn(),
  };
});

import { acknowledgeChatTurn, fetchChatSessionMessages, fetchChatThreads, fetchChatTurnStatus } from '../../api';

const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatSessionMessagesMock = vi.mocked(fetchChatSessionMessages);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);

const IDLE: ChatTurnStatusDto = { state: 'idle' };
const COMPLETED: ChatTurnStatusDto = {
  state: 'completed',
  sessionId: 'sess-1',
  agentId: 'claude',
  completedAt: '2026-01-01T00:00:00Z',
};

// 参照を安定させる(effect の依存配列に入るため)。
const setLoadingHistoryFor = vi.fn();
const clearStreamingReplyForKey = vi.fn();
const clearUnresolvedSend = vi.fn();

function useRecoveryProbe({ generation, applyRecoveredTurn }: {
  generation: number;
  applyRecoveredTurn: (threads: ChatThreadDto[], payload: ChatSessionMessagesDto) => void;
}) {
  const detachedSendsRef = useRef<Record<string, DetachedTurnSend>>({});
  const historyRequestIdRef = useRef(0);
  const threadListRequestIdRef = useRef(0);
  useTurnStatusRecovery({
    selectedProjectId: 'proj-a',
    generation,
    detachedSendsRef,
    historyRequestIdRef,
    threadListRequestIdRef,
    setLoadingHistoryFor,
    clearStreamingReplyForKey,
    clearUnresolvedSend,
    applyRecoveredTurn,
  });
  return { historyRequestIdRef, threadListRequestIdRef };
}

function renderProbe() {
  const applyRecoveredTurn = vi.fn();
  const rendered = renderHook(
    (props: { generation: number }) => useRecoveryProbe({ generation: props.generation, applyRecoveredTurn }),
    { initialProps: { generation: 0 } },
  );
  return { ...rendered, applyRecoveredTurn };
}

describe('useTurnStatusRecovery request-id guards', () => {
  beforeEach(() => {
    fetchChatTurnStatusMock.mockResolvedValue(IDLE);
    acknowledgeChatTurnMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not advance the thread-list request id when a generation bump restarts the effect (bdboard-x4mv)', async () => {
    const { result, rerender } = renderProbe();
    await waitFor(() => expect(fetchChatTurnStatusMock).toHaveBeenCalledTimes(1));
    // useThreadListSync がこの時点で一覧 fetch を始めていた(id を1つ進めた)とみなす。
    const inFlightThreadListRequestId = ++result.current.threadListRequestIdRef.current;

    rerender({ generation: 1 });
    await waitFor(() => expect(fetchChatTurnStatusMock).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });

    // idle なので hydrate しない。一覧の request-id は動かず、in-flight の一覧応答は生きている。
    expect(result.current.threadListRequestIdRef.current).toBe(inFlightThreadListRequestId);
    expect(fetchChatThreadsMock).not.toHaveBeenCalled();
  });

  it('still advances the thread-list request id right before hydrating a recovered turn', async () => {
    fetchChatTurnStatusMock.mockResolvedValueOnce(COMPLETED).mockResolvedValue(IDLE);
    const threads: ChatThreadDto[] = [
      { sessionId: 'sess-1', agentId: 'claude', title: 'recovered', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
    ];
    const payload: ChatSessionMessagesDto = { sessionId: 'sess-1', agentId: 'claude', messages: [] };
    const probe: { ref?: { current: number }; idAtFetch?: number } = {};
    fetchChatThreadsMock.mockImplementation(() => {
      probe.idAtFetch = probe.ref?.current;
      return Promise.resolve(threads);
    });
    fetchChatSessionMessagesMock.mockResolvedValue(payload);

    const { result, applyRecoveredTurn } = renderProbe();
    probe.ref = result.current.threadListRequestIdRef;

    await waitFor(() => expect(applyRecoveredTurn).toHaveBeenCalledWith(threads, payload));
    // hydrate の fetch より前に id が進んでいる = それ以前に始まった一覧応答は捨てられる。
    expect(probe.idAtFetch).toBe(1);
    expect(result.current.threadListRequestIdRef.current).toBe(1);
  });

  it('drops a hydrate whose thread-list request id was superseded while its fetch was in flight', async () => {
    fetchChatTurnStatusMock.mockResolvedValueOnce(COMPLETED).mockResolvedValue(IDLE);
    let resolveThreads!: (threads: ChatThreadDto[]) => void;
    fetchChatThreadsMock.mockImplementation(
      () => new Promise<ChatThreadDto[]>((resolve) => { resolveThreads = resolve; }),
    );
    fetchChatSessionMessagesMock.mockResolvedValue({ sessionId: 'sess-1', agentId: 'claude', messages: [] });

    const { result, applyRecoveredTurn } = renderProbe();
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
    // 回収の fetch 中に、より新しい一覧 fetch が始まった(useThreadListSync が id を進めた)。
    result.current.threadListRequestIdRef.current += 1;
    await act(async () => {
      resolveThreads([]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(applyRecoveredTurn).not.toHaveBeenCalled();
  });
});
