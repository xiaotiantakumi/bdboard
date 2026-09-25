// bdboard-d7on: openThreadIdsRef (chat/useChatThreadLists.ts) も
// draftNoncesRef/selectedThreadIdsRef (bdboard-d29q) と同じ render-mirror
// (フック本体のトップレベルで `openThreadIdsRef.current = openThreadIds` する
// だけで、次の再レンダーまで setOpenThreadIds の更新に追いつかない)。
//
// ケース1 (P2, bdboard-g8e7 コメント item 1 / Opus レビュー再現): E12(履歴
// ローダー)の 404 回復 handleHistorySessionGone が setOpenThreadIds で
// 死亡セッションを除いた直後、再レンダーを挟まずに turn-status 回収の
// applyRecoveredTurn が同 tick で届くと、applyRecoveredTurn が読む
// openThreadIdsRef.current はまだ古い(死亡セッションを含んだままの)配列で、
// nextOpen の計算・setOpenThreadIds・永続化のすべてに死亡セッションが
// 無言で復活する。bdboard-d29q と同じ force-ordering(sleep 無し、同じ
// act() コールバック内で2つの関数を直接連続呼び出し)で再現する。
//
// ケース2 (item 2, bdboard-g8e7 コメント): useChatSessionLifecycle.ts の
// handleResumeDiscoveredSession が、E7(chat/useThreadListSync.ts)の初回
// スレッド一覧 fetch が解決する前に呼ばれると、まだ空の openThreads から
// 計算した「resumed セッションだけの」open 配列を persisted へ書いてしまい、
// その後解決する E7 が(このプロジェクトをまだ復元済みとマークしていなければ)
// その書き込みをそのまま restoreThreadView の入力にしてしまう ―― 以前から
// 永続化されていた他のスレッドが無言で消える。sleep ではなく、
// fetchChatThreads の解決を手動で制御する(保留してから resolve する)ことで
// 決定的に再現する。
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionMessagesDto, ChatThreadDto } from '../../api';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../../chatThreadStorage';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, fetchChatThreads: vi.fn() };
});

import { fetchChatThreads } from '../../api';
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
 * chat/useChatPanelSync.ts が実際に組み立てる順序をそのまま踏む probe:
 * useConversationKey → useDraftThreadLauncher → useThreadListSync(E7) →
 * useChatSessionLifecycle。openThreadIds/openThreadIdsRef は
 * chat/useChatThreadLists.ts の該当部分(state + 「関数本体トップレベルで
 * ref.current = state」という render-mirror)だけを、drawer 操作など無関係な
 * 依存を持ち込まずに忠実に再現する。
 */
function useProbe(projectId: string) {
  const key = useConversationKey(projectId);

  const [openThreadIds, setOpenThreadIds] = useState<Record<string, string[]>>({});
  // chat/useChatThreadLists.ts:100-101 と同じ render-mirror。
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

  return {
    key, launcher, lifecycle, openThreadIds, openThreadIdsRef, restoredProjectsRef,
    threadLists, threadError, selectedAgentId, historyLoadedFor, threadModelIds, loadingHistoryFor,
  };
}

describe('openThreadIdsRef render-mirror race (bdboard-d7on)', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchChatThreadsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not resurrect a session that handleHistorySessionGone just removed, when turn-status recovery hydrates in the same tick (P2, force-ordering repro, no sleep)', async () => {
    fetchChatThreadsMock.mockResolvedValue([thread('sess-dead', 'dead'), thread('sess-2', 'second')]);
    const { result } = renderHook(() => useProbe('project-a'));

    // E7 の初回 fetch を解決させ、openThreadIds/restoredProjectsRef を
    // 「復元済み(['sess-dead', 'sess-2'] が open)」の状態にする。
    await waitFor(() => {
      expect(result.current.openThreadIds['project-a']).toEqual(['sess-dead', 'sess-2']);
    });
    expect(result.current.restoredProjectsRef.current.has('project-a')).toBe(true);

    act(() => {
      // E12(履歴ローダー)の 404 回復: sess-dead を open から除く。
      result.current.lifecycle.handleHistorySessionGone('sess-dead');
      // 直後、再レンダーを1度も挟まないまま turn-status 回収の hydrate が
      // 届く(sess-dead とは無関係な sess-rec の回収)。
      result.current.lifecycle.applyRecoveredTurn(
        [thread('sess-2', 'second'), thread('sess-rec', 'recovered')],
        RECOVERED,
      );
    });

    // 修正前の壊れ方: applyRecoveredTurn が読む openThreadIdsRef.current は
    // まだ handleHistorySessionGone の setOpenThreadIds に追いついておらず
    // ['sess-dead', 'sess-2'] のまま。nextOpen の計算がこれを丸ごと base に
    // するため、sess-dead が open にも永続化にも無言で復活する。
    expect(result.current.openThreadIds['project-a']).toEqual(['sess-2', 'sess-rec']);
    expect(readPersistedChatThreads()['project-a']?.activeSessionIds).toEqual(['sess-2', 'sess-rec']);
  });

  it('does not let a session resumed before the initial thread-list fetch resolves get clobbered by that fetch (item 2, bdboard-g8e7, controlled promise ordering, no sleep)', async () => {
    // このプロジェクトは以前の訪問で sess-existing を開いたまま永続化済み。
    writePersistedChatThreadState('project-a', {
      activeSessionIds: ['sess-existing'],
      selectedSessionId: 'sess-existing',
    });

    let resolveFetch: ((threads: ChatThreadDto[]) => void) | undefined;
    fetchChatThreadsMock.mockReturnValue(
      new Promise<ChatThreadDto[]>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { result } = renderHook(() => useProbe('project-a'));
    // マウント時に E7 の effect が発火し、fetchChatThreads が呼ばれるが、
    // まだ解決していない(resolveFetch を握ったまま)。
    expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1);
    expect(result.current.restoredProjectsRef.current.has('project-a')).toBe(false);

    act(() => {
      // E7 の fetch が解決するより前に、ユーザーが「CLI セッションを再開」を押す。
      result.current.lifecycle.handleResumeDiscoveredSession('sess-resumed', 'agent-b', []);
    });

    await act(async () => {
      resolveFetch?.([
        thread('sess-existing', 'existing'),
        thread('sess-resumed', 'resumed'),
      ]);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.restoredProjectsRef.current.has('project-a')).toBe(true);
    });

    // 修正前の壊れ方: handleResumeDiscoveredSession は(E7 未解決なので)
    // openThreads=[] から nextOpenThreads=['sess-resumed'] を計算して
    // persisted へ書く。E7 はまだ復元済みマークを見ていないので、その
    // 書き込みをそのまま restoreThreadView の入力にし、sess-existing が
    // open からも永続化からも無言で消える。
    expect(result.current.openThreadIds['project-a']).toEqual(
      expect.arrayContaining(['sess-existing', 'sess-resumed']),
    );
    expect(readPersistedChatThreads()['project-a']?.activeSessionIds).toEqual(
      expect.arrayContaining(['sess-existing', 'sess-resumed']),
    );
  });
});
