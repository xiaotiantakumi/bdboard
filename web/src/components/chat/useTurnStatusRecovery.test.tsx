// bdboard-x4mv / bdboard-ibkf: useTurnStatusRecovery(turn-status 回収 = 設計書 §1c の
// E8)の request-id の扱いを直接確かめる。generation の bump(ストリームの abort など)で
// effect が張り直されても、スレッド一覧・履歴の request-id は進めない(進めると、同時に
// 走っている useThreadListSync の一覧 fetch / useChatHistoryLoader の履歴 fetch を
// 握りつぶす)。進めるのは回収したターンを当てる直前だけ(hydrate の fetch の後。一覧は
// bdboard-tsen、履歴は bdboard-lsv2)で、そこでは従来どおり古い応答を無効化する。
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
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

function useRecoveryProbe({ projectId, generation, applyRecoveredTurn, onListFetch }: {
  projectId: string;
  generation: number;
  applyRecoveredTurn: (threads: ChatThreadDto[], payload: ChatSessionMessagesDto) => void;
  onListFetch: (projectId: string, requestId: number) => void;
}) {
  const detachedSendsRef = useRef<Record<string, DetachedTurnSend>>({});
  const historyRequestIdRef = useRef(0);
  const threadListRequestIdRef = useRef(0);
  // useThreadListSync(E7)の request-id の取り方だけを真似る。ChatPanel と同じく
  // E8 より前に登録するので、プロジェクト切替の同じコミットでは E7 → E8 の順に走る。
  useEffect(() => {
    onListFetch(projectId, ++threadListRequestIdRef.current);
  }, [projectId, onListFetch]);
  useTurnStatusRecovery({
    selectedProjectId: projectId,
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

function renderProbe(initial: { projectId?: string; generation?: number } = {}) {
  const applyRecoveredTurn = vi.fn();
  const listFetchIds: Record<string, number> = {};
  const onListFetch = (projectId: string, requestId: number) => { listFetchIds[projectId] = requestId; };
  const rendered = renderHook(
    (props: { projectId: string; generation: number }) =>
      useRecoveryProbe({ ...props, applyRecoveredTurn, onListFetch }),
    { initialProps: { projectId: initial.projectId ?? 'proj-a', generation: initial.generation ?? 0 } },
  );
  return { ...rendered, applyRecoveredTurn, listFetchIds };
}

describe('useTurnStatusRecovery request-id guards', () => {
  beforeEach(() => {
    fetchChatTurnStatusMock.mockResolvedValue(IDLE);
    acknowledgeChatTurnMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // bdboard-1ga8 と同じ作法: モックを片付ける前にアンマウントし、ポーリングや再試行の
    // タイマーが次のテストへ持ち越されないようにする。reset で実装も戻す(失敗させる
    // 実装などが後のテストへ残らないように)。
    try {
      cleanup();
    } finally {
      vi.resetAllMocks();
    }
  });

  it('does not advance the thread-list request id when a generation bump restarts the effect (bdboard-x4mv)', async () => {
    const { result, rerender, listFetchIds } = renderProbe();
    await waitFor(() => expect(fetchChatTurnStatusMock).toHaveBeenCalledTimes(1));
    // E7 が proj-a の一覧 fetch を始めた(id を1つ進めた)まま、abort 由来の bump が遅れて届く。
    rerender({ projectId: 'proj-a', generation: 1 });
    await waitFor(() => expect(fetchChatTurnStatusMock).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // idle なので hydrate しない。一覧の request-id は動かず、in-flight の一覧応答は生きている。
    expect(result.current.threadListRequestIdRef.current).toBe(listFetchIds['proj-a']);
    expect(fetchChatThreadsMock).not.toHaveBeenCalled();
  });

  it('keeps the list request id E7 took for a project switched to after an earlier generation bump (bdboard-x4mv)', async () => {
    // generation は減らないので、タブ内で一度でも abort / 配信停止があると、以後の
    // プロジェクト切替は毎回「E7 が id を取る → 同じコミットの E8 が張り直す」になる。
    const { result, rerender, listFetchIds } = renderProbe({ generation: 1 });
    await waitFor(() => expect(fetchChatTurnStatusMock).toHaveBeenCalledWith('proj-a'));

    rerender({ projectId: 'proj-b', generation: 1 });
    await waitFor(() => expect(fetchChatTurnStatusMock).toHaveBeenCalledWith('proj-b'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(listFetchIds['proj-b']).toBeGreaterThan(listFetchIds['proj-a']);
    expect(result.current.threadListRequestIdRef.current).toBe(listFetchIds['proj-b']);
  });

  it('still advances the thread-list request id right before hydrating a recovered turn', async () => {
    fetchChatTurnStatusMock.mockResolvedValueOnce(COMPLETED).mockResolvedValue(IDLE);
    const threads: ChatThreadDto[] = [
      { sessionId: 'sess-1', agentId: 'claude', title: 'recovered', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
    ];
    const payload: ChatSessionMessagesDto = { sessionId: 'sess-1', agentId: 'claude', messages: [] };
    const probe: { ref?: { current: number }; idAtFetch?: number; idAtApply?: number } = {};
    fetchChatThreadsMock.mockImplementation(() => {
      probe.idAtFetch = probe.ref?.current;
      return Promise.resolve(threads);
    });
    fetchChatSessionMessagesMock.mockResolvedValue(payload);

    const { result, applyRecoveredTurn, listFetchIds } = renderProbe();
    probe.ref = result.current.threadListRequestIdRef;
    applyRecoveredTurn.mockImplementation(() => {
      probe.idAtApply = probe.ref?.current;
    });

    await waitFor(() => expect(applyRecoveredTurn).toHaveBeenCalledWith(threads, payload));
    // bdboard-tsen: hydrate の fetch 中は id を進めない(その間に届く E7 の一覧応答は生きていて、
    // 永続化済み open/選択の復元と pending ドラフトの消化を行える)。当てる直前に進めるので、
    // それより後に届く E7 の応答は一覧・open・選択を当てない。
    expect(probe.idAtFetch).toBe(listFetchIds['proj-a']);
    expect(probe.idAtApply).toBe(listFetchIds['proj-a'] + 1);
    expect(result.current.threadListRequestIdRef.current).toBe(listFetchIds['proj-a'] + 1);
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(applyRecoveredTurn).not.toHaveBeenCalled();
    // bdboard-lsv2: 当てずに捨てた hydrate は履歴の request-id も進めない。
    expect(result.current.historyRequestIdRef.current).toBe(0);
    expect(setLoadingHistoryFor).not.toHaveBeenCalledWith(null);
  });

  it('does not advance the history request id nor clear the history loading flag on a generation bump (bdboard-ibkf)', async () => {
    const { result, rerender } = renderProbe();
    await waitFor(() => expect(fetchChatTurnStatusMock).toHaveBeenCalledTimes(1));
    // useChatHistoryLoader が未読込スレッドの履歴 fetch を始めていた(その時点の id を控えた)とみなす。
    const inFlightHistoryRequestId = result.current.historyRequestIdRef.current;
    setLoadingHistoryFor.mockClear();

    rerender({ projectId: 'proj-a', generation: 1 });
    await waitFor(() => expect(fetchChatTurnStatusMock).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // idle なので hydrate しない。in-flight の履歴応答はそのまま当たり、loading もそれが解く。
    expect(result.current.historyRequestIdRef.current).toBe(inFlightHistoryRequestId);
    expect(setLoadingHistoryFor).not.toHaveBeenCalled();
  });

  it('still advances the history request id and clears the loading flag right before hydrating', async () => {
    fetchChatTurnStatusMock.mockResolvedValueOnce(COMPLETED).mockResolvedValue(IDLE);
    const probe: {
      ref?: { current: number };
      idAtFetch?: number;
      loadingClearedBeforeFetch?: boolean;
      idAtApply?: number;
      loadingClearedBeforeApply?: boolean;
    } = {};
    fetchChatThreadsMock.mockResolvedValue([]);
    fetchChatSessionMessagesMock.mockImplementation(() => {
      probe.idAtFetch = probe.ref?.current;
      probe.loadingClearedBeforeFetch = setLoadingHistoryFor.mock.calls.some(([value]) => value === null);
      return Promise.resolve({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
    });

    const { result, applyRecoveredTurn } = renderProbe();
    probe.ref = result.current.historyRequestIdRef;
    applyRecoveredTurn.mockImplementation(() => {
      probe.idAtApply = probe.ref?.current;
      probe.loadingClearedBeforeApply = setLoadingHistoryFor.mock.calls.some(([value]) => value === null);
    });

    await waitFor(() => expect(applyRecoveredTurn).toHaveBeenCalledTimes(1));
    // bdboard-lsv2: hydrate の fetch 中は id を進めず loading も外さない(その間に届く
    // useChatHistoryLoader の応答は生きている)。当てる直前に進めるので、それより後に届く
    // 履歴応答は捨てられ、回収結果を上書きしない。
    expect(probe.idAtFetch).toBe(0);
    expect(probe.loadingClearedBeforeFetch).toBe(false);
    expect(probe.idAtApply).toBe(1);
    expect(probe.loadingClearedBeforeApply).toBe(true);
    expect(result.current.historyRequestIdRef.current).toBe(1);
  });

  it('does not advance the history request id nor clear the loading flag when the hydrate fetch fails (bdboard-lsv2)', async () => {
    fetchChatTurnStatusMock.mockResolvedValueOnce(COMPLETED).mockResolvedValue(IDLE);
    fetchChatThreadsMock.mockRejectedValue(new Error('hydrate list failed'));
    fetchChatSessionMessagesMock.mockResolvedValue({ sessionId: 'sess-1', agentId: 'claude', messages: [] });

    const { result, applyRecoveredTurn } = renderProbe();
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // 失敗した hydrate は何も当てないので、in-flight の履歴応答を捨てる理由も無い。
    expect(applyRecoveredTurn).not.toHaveBeenCalled();
    expect(result.current.historyRequestIdRef.current).toBe(0);
    expect(setLoadingHistoryFor).not.toHaveBeenCalledWith(null);
  });

  it('does not advance the history request id when a generation bump cancels an in-flight hydrate (bdboard-lsv2)', async () => {
    fetchChatTurnStatusMock.mockResolvedValueOnce(COMPLETED).mockResolvedValue(IDLE);
    let resolveThreads!: (threads: ChatThreadDto[]) => void;
    fetchChatThreadsMock.mockImplementation(
      () => new Promise<ChatThreadDto[]>((resolve) => { resolveThreads = resolve; }),
    );
    fetchChatSessionMessagesMock.mockResolvedValue({ sessionId: 'sess-1', agentId: 'claude', messages: [] });

    const { result, rerender, applyRecoveredTurn } = renderProbe();
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
    rerender({ projectId: 'proj-a', generation: 1 });
    await waitFor(() => expect(fetchChatTurnStatusMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveThreads([]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(applyRecoveredTurn).not.toHaveBeenCalled();
    expect(result.current.historyRequestIdRef.current).toBe(0);
    expect(setLoadingHistoryFor).not.toHaveBeenCalledWith(null);
  });
});
