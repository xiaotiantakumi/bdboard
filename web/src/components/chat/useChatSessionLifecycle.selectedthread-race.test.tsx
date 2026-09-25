// bdboard-d7on(Opus レビュー B1/M1 対応): openThreadIdsRef の同期(このチケットの
// 主眼)を各 setOpenThreadIds の書き込み箇所へ広げたところ、同じ render-mirror
// クラスの別のバグ(selectedThreadIdsRef の同期漏れ)が、これまで
// openThreadIdsRef 側の古さによって「たまたま」隠されていたことが分かった
// (レビュー指摘 B1)。具体的には、applyRecoveredTurn の alreadyRestored 判定
// (knownOpen !== undefined)が、openThreadIdsRef が同期される前は常に false に
// 倒れて restoreThreadView を毎回呼び直していたため、selectedThreadIdsRef が
// 古くても currentSelected は restored?.selected で正しく上書きされていた。
// openThreadIdsRef を同期した結果 alreadyRestored が true になるケースが増え、
// その分岐では selectedThreadIdsRef.current がそのまま使われるため、E7 の
// restore・useChatSendCommits の commitSuccess・handleResumeDiscoveredSession が
// selectedThreadIdsRef を同期していないと、同 tick の後続 hydrate
// (applyRecoveredTurn)が選択を無言で回収セッションへ倒す/古い選択へ戻してしまう。
// ここでは openThreadIdsRef 側 (useChatSessionLifecycle.openthread-race.test.tsx)
// と同じ force-ordering 手法(sleep 無し、同じ act() コールバック内で書き手→読み手を
// 直接連続呼び出し)で、selectedThreadIdsRef を同期する3つの書き手(commitSuccess /
// E7 の restore / handleResumeDiscoveredSession)それぞれについて、直後の同 tick
// hydrate が正しい選択を保つことを確認する。
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionMessagesDto, ChatThreadDto } from '../../api';
import { writePersistedChatThreadState } from '../../chatThreadStorage';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, fetchChatThreads: vi.fn(), acknowledgeChatTurn: vi.fn(() => Promise.resolve()) };
});

import { fetchChatThreads } from '../../api';
import { makeDraftKey } from './draftKey';
import { useChatSendCommits } from './useChatSendCommits';
import { useChatSessionLifecycle } from './useChatSessionLifecycle';
import { useConversationKey } from './useConversationKey';
import { useDraftThreadLauncher } from './useDraftThreadLauncher';
import { useThreadListSync } from './useThreadListSync';

const fetchChatThreadsMock = vi.mocked(fetchChatThreads);

function thread(sessionId: string, title: string): ChatThreadDto {
  return { sessionId, agentId: 'agent-a', title, pinned: false, updatedAt: '2026-01-01T00:00:00.000Z' };
}

const RECOVERED: ChatSessionMessagesDto = {
  sessionId: 'sess-rec',
  agentId: 'agent-b',
  model: 'model-2',
  messages: [{ role: 'assistant', content: 'recovered', createdAt: '2026-08-18T12:00:00.000Z' }],
};

/**
 * chat/useChatPanelSync.ts / useChatPanelComposer.ts が実際に組み立てる順序を
 * そのまま踏む probe(useThreadListSync.openthread-race.test.tsx の useProbe に
 * useChatSendCommits(E13)を足したもの)。
 */
function useProbe(projectId: string) {
  const key = useConversationKey(projectId);

  const [openThreadIds, setOpenThreadIds] = useState<Record<string, string[]>>({});
  const openThreadIdsRef = useRef(openThreadIds);
  openThreadIdsRef.current = openThreadIds;
  const restoredProjectsRef = useRef<Set<string>>(new Set());

  const [threadLists, setThreadLists] = useState<Record<string, ChatThreadDto[]>>({});
  const [, setConversations] = useState<Record<string, unknown>>({});
  const [historyLoadedFor, setHistoryLoadedFor] = useState<Record<string, true>>({});
  const [loadingHistoryFor, setLoadingHistoryFor] = useState<string | null>(null);
  const [threadModelIds, setThreadModelIds] = useState<Record<string, string>>({});
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [threadError, setThreadError] = useState<string | null>(null);

  const historyRequestIdRef = useRef(0);
  const threadListRequestIdRef = useRef(0);
  const conversationInputsRef = useRef<Record<string, string>>({});
  const conversationAttachmentsRef = useRef<Record<string, never[]>>({});
  const draftSeedTextRef = useRef<Record<string, string>>({});
  const [setInput] = useState(() => vi.fn());
  const [updateConversationInputs] = useState(() => vi.fn());
  const [updateConversationAttachments] = useState(() => vi.fn());
  const [clearAttachmentError] = useState(() => vi.fn());
  const [cancelThreadConfirmDelete] = useState(() => vi.fn());

  const launcher = useDraftThreadLauncher({
    selectedProjectId: projectId,
    currentConversationKey: key.currentConversationKey,
    draftNoncesRef: key.draftNoncesRef,
    selectedThreadIdsRef: key.selectedThreadIdsRef,
    setDraftNonces: key.setDraftNonces,
    setSelectedThreadIds: key.setSelectedThreadIds,
    historyRequestIdRef,
    setConversations: setConversations as never,
    setHistoryLoadedFor,
    setLoadingHistoryFor,
    setThreadModelIds,
    conversationInputsRef,
    conversationAttachmentsRef,
    draftSeedTextRef,
    setInput,
    updateConversationInputs,
    updateConversationAttachments,
    clearAttachmentError,
    setOpenThreadIds,
    openThreadIdsRef,
    restoredProjectsRef,
    setSelectedAgentId,
    cancelThreadConfirmDelete,
  });

  useThreadListSync({
    selectedProjectId: projectId,
    setThreadError,
    pendingPrefillRef: launcher.pendingPrefillRef,
    pendingTicketDraftProjectRef: launcher.pendingTicketDraftProjectRef,
    threadListRequestIdRef,
    draftNoncesRef: key.draftNoncesRef,
    selectedThreadIdsRef: key.selectedThreadIdsRef,
    setThreadLists,
    setOpenThreadIds,
    openThreadIdsRef,
    setSelectedThreadIds: key.setSelectedThreadIds,
    startNewDraftThread: launcher.startNewDraftThread,
    restoredProjectsRef,
  });

  const lifecycle = useChatSessionLifecycle({
    selectedProjectId: projectId,
    selectedThreadIdsRef: key.selectedThreadIdsRef,
    setSelectedThreadIds: key.setSelectedThreadIds,
    draftNoncesRef: key.draftNoncesRef,
    historyRequestIdRef,
    setConversations: setConversations as never,
    setHistoryLoadedFor,
    setLoadingHistoryFor,
    setThreadModelIds,
    openThreads: openThreadIds[projectId] ?? [],
    openThreadIdsRef,
    restoredProjectsRef,
    setThreadLists,
    setOpenThreadIds,
    setSelectedAgentId,
    cancelThreadConfirmDelete,
    advanceDraftNonceAfterSessionGone: launcher.advanceDraftNonceAfterSessionGone,
  });

  const commits = useChatSendCommits({
    selectedProjectId: projectId,
    showModelSelect: false,
    effectiveModelId: '',
    setConversations: setConversations as never,
    setHistoryLoadedFor,
    setThreadModelIds,
    setThreadLists,
    setOpenThreadIds,
    openThreadIdsRef,
    setSelectedThreadIds: key.setSelectedThreadIds,
    selectedThreadIdsRef: key.selectedThreadIdsRef,
    conversationInputsRef,
    conversationAttachmentsRef,
    setInput,
    updateConversationAttachments,
  });

  return {
    commits, key, launcher, lifecycle, openThreadIds, openThreadIdsRef, restoredProjectsRef,
    threadLists, threadError, selectedAgentId, historyLoadedFor, threadModelIds, loadingHistoryFor,
  };
}

describe('selectedThreadIdsRef render-mirror race (bdboard-d7on, Opus review B1/M1)', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchChatThreadsMock.mockReset();
  });

  it('keeps the just-committed session selected when turn-status recovery hydrates in the same tick as commitSuccess (M1)', async () => {
    fetchChatThreadsMock.mockResolvedValue([thread('sess-1', 'one')]);
    const { result } = renderHook(() => useProbe('project-a'));
    await waitFor(() => expect(result.current.openThreadIds['project-a']).toEqual(['sess-1']));

    // ユーザーがドラフトを開始する(nonce を進め、選択を undefined にする)。
    act(() => {
      result.current.launcher.handleNewThread();
    });
    expect(result.current.key.selectedThreadIds['project-a']).toBeUndefined();

    const draftKey = makeDraftKey('project-a', 1);
    act(() => {
      // ドラフトからの送信が成功し、確定 sessionId が選ばれた直後、再レンダーを
      // 挟まないまま turn-status 回収の hydrate が別セッションの回収を届ける。
      result.current.commits.commitSuccess(draftKey, 'hello', {
        reply: 'r', sessionId: 'sess-new', agentId: 'agent-a',
      });
      result.current.lifecycle.applyRecoveredTurn(
        [thread('sess-1', 'one'), thread('sess-new', 'new'), thread('sess-rec', 'recovered')],
        RECOVERED,
      );
    });

    // 修正前の壊れ方: commitSuccess は selectedThreadIdsRef を同期しないため、
    // 直後の applyRecoveredTurn が読む selectedThreadIdsRef.current はまだ
    // undefined(ドラフト由来)のまま。currentSelected が undefined のため
    // nextSelected が回収セッション(sess-rec)に倒れ、確定したばかりの
    // sess-new から選択が無言ですり替わっていた。
    expect(result.current.openThreadIds['project-a']).toEqual(['sess-1', 'sess-new', 'sess-rec']);
    expect(result.current.key.selectedThreadIds['project-a']).toBe('sess-new');
  });

  it('keeps the persisted selection when turn-status recovery hydrates in the same tick as E7 restoring an already-visited project (B1)', async () => {
    writePersistedChatThreadState('project-a', {
      activeSessionIds: ['sess-1', 'sess-2'],
      selectedSessionId: 'sess-2',
    });
    let resolveFetch: ((threads: ChatThreadDto[]) => void) | undefined;
    fetchChatThreadsMock.mockReturnValue(
      new Promise<ChatThreadDto[]>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { result } = renderHook(() => useProbe('project-a'));
    const threads = [thread('sess-1', 'one'), thread('sess-2', 'two')];

    await act(async () => {
      // E7 の初回 fetch が解決し、restore(open/選択の復元・restoredProjectsRef
      // のマーク)まで一気に走るが、再レンダーはまだ挟まない。同じ flush の中で
      // turn-status 回収の hydrate が届く。
      resolveFetch?.(threads);
      await Promise.resolve();
      expect(result.current.restoredProjectsRef.current.has('project-a')).toBe(true);
      result.current.lifecycle.applyRecoveredTurn(
        [...threads, thread('sess-rec', 'recovered')],
        RECOVERED,
      );
    });

    // 修正前の壊れ方(B1、Opus レビュー指摘): openThreadIdsRef の同期により
    // applyRecoveredTurn の alreadyRestored 判定が true になり、
    // restoreThreadView をやり直さなくなった結果、selectedThreadIdsRef の
    // 同期漏れが露出し、直前まで選ばれていた sess-2 ではなく回収セッション
    // (sess-rec)が無言で選ばれてしまっていた。
    expect(result.current.openThreadIds['project-a']).toEqual(['sess-1', 'sess-2', 'sess-rec']);
    expect(result.current.key.selectedThreadIds['project-a']).toBe('sess-2');
  });

  it('keeps a just-resumed CLI session selected when turn-status recovery hydrates in the same tick as handleResumeDiscoveredSession', async () => {
    fetchChatThreadsMock.mockResolvedValue([thread('sess-1', 'one')]);
    const { result } = renderHook(() => useProbe('project-a'));
    await waitFor(() => expect(result.current.openThreadIds['project-a']).toEqual(['sess-1']));

    act(() => {
      // ドロワーから CLI セッションを再開した直後、再レンダーを挟まないまま
      // turn-status 回収の hydrate が別セッションの回収を届ける。
      result.current.lifecycle.handleResumeDiscoveredSession('sess-resumed', 'agent-b', []);
      result.current.lifecycle.applyRecoveredTurn(
        [thread('sess-1', 'one'), thread('sess-rec', 'recovered')],
        RECOVERED,
      );
    });

    expect(result.current.openThreadIds['project-a']).toEqual(['sess-1', 'sess-resumed', 'sess-rec']);
    expect(result.current.key.selectedThreadIds['project-a']).toBe('sess-resumed');
  });
});
