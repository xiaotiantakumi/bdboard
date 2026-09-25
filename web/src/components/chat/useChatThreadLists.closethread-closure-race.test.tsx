// bdboard-ygrg: bdboard-197q (PR #793) の Opus レビューで見つかった別系統の
// バグの再現テスト。bdboard-197q が直したのは selectedThreadIdsRef の
// render-mirror 同期漏れ(1レンダー遅れる ref)だったが、これとは別に
// closeThread 自体の「次の open リスト」計算 (next = openThreads.filter(...))
// が render-time の openThreads state を素朴なクロージャで読んでいる。
//
// closeThread は onClick から直接呼ばれる経路に加え、deleteThread の async
// 継続からも呼ばれる:
//
//   const deleteThread = async (sessionId) => {
//     await deleteChatThread(sessionId, selectedProjectId);  // ← ここでネット
//                                                                ワーク待ち
//     closeThread(sessionId);                                // ← await の続き
//     ...                                                        (deleteThread
//   };                                                            が定義された
//                                                                  render の
//                                                                  closeThread/
//                                                                  openThreads
//                                                                  を捕まえた
//                                                                  まま)
//
// deleteChatThread の await は現実のネットワーク往復であり、bdboard-197q の
// 各バグと違って「同 tick で偶然 2つの async resolve が連続する」ような特殊な
// force-ordering を一切要求しない。delete が in-flight の間にユーザーが別の
// スレッドを reopen する(ごく普通の同期 onClick)だけで、次の setOpenThreadIds
// が古いスナップショットで丸ごと上書きし、reopen した分を黙って消してしまう。
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { writePersistedChatThreadState } from '../../chatThreadStorage';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    fetchChatThreads: vi.fn(),
    acknowledgeChatTurn: vi.fn(() => Promise.resolve()),
    deleteChatThread: vi.fn(),
  };
});

import { deleteChatThread, fetchChatThreads } from '../../api';
import { useChatSessionLifecycle } from './useChatSessionLifecycle';
import { useChatThreadLists } from './useChatThreadLists';
import { useConversationKey } from './useConversationKey';
import { useDraftThreadLauncher } from './useDraftThreadLauncher';
import { useThreadListSync } from './useThreadListSync';

const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const deleteChatThreadMock = vi.mocked(deleteChatThread);

function thread(sessionId: string, title: string): ChatThreadDto {
  return { sessionId, agentId: 'agent-a', title, pinned: false, updatedAt: '2026-01-01T00:00:00.000Z' };
}

/**
 * useChatThreadLists.closethread-race.test.tsx の useProbe と同一
 * (本番の chat/useChatPanelStores.ts → useChatPanelAgentAndLauncher.ts →
 * useChatPanelSync.ts の組み立て順をそのまま踏む)。closeThread/deleteThread/
 * reopenClosedThread を実際に呼ぶには、useChatThreadLists を唯一の所有者とする
 * この一貫性が要る。
 */
function useProbe(projectId: string) {
  const key = useConversationKey(projectId);

  const [, setConversations] = useState<Record<string, unknown>>({});
  const [historyLoadedFor, setHistoryLoadedFor] = useState<Record<string, true>>({});
  const [loadingHistoryFor, setLoadingHistoryFor] = useState<string | null>(null);
  const [threadModelIds, setThreadModelIds] = useState<Record<string, string>>({});
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [threadError, setThreadError] = useState<string | null>(null);
  const [renameDraft] = useState('');

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
  const [selectThreadDrawerThread] = useState(() => vi.fn());
  const [cancelThreadInteractionsForSession] = useState(() => vi.fn());
  const [cancelThreadRename] = useState(() => vi.fn());
  const [closeThreadDrawer] = useState(() => vi.fn());

  const threadLists = useChatThreadLists({
    selectedProjectId: projectId,
    currentSessionId: key.currentSessionId,
    setSelectedThreadIds: key.setSelectedThreadIds,
    selectedThreadIdsRef: key.selectedThreadIdsRef,
    setThreadError,
    renameDraft,
    drawer: {
      selectThread: selectThreadDrawerThread,
      cancelInteractionsForSession: cancelThreadInteractionsForSession,
      cancelConfirmDelete: cancelThreadConfirmDelete,
      cancelRename: cancelThreadRename,
      closeDrawer: closeThreadDrawer,
    },
  });

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
    setOpenThreadIds: threadLists.setOpenThreadIds,
    openThreadIdsRef: threadLists.openThreadIdsRef,
    restoredProjectsRef: threadLists.restoredProjectsRef,
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
    setThreadLists: threadLists.setThreadLists,
    setOpenThreadIds: threadLists.setOpenThreadIds,
    openThreadIdsRef: threadLists.openThreadIdsRef,
    setSelectedThreadIds: key.setSelectedThreadIds,
    startNewDraftThread: launcher.startNewDraftThread,
    restoredProjectsRef: threadLists.restoredProjectsRef,
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
    openThreads: threadLists.openThreads,
    openThreadIdsRef: threadLists.openThreadIdsRef,
    restoredProjectsRef: threadLists.restoredProjectsRef,
    setThreadLists: threadLists.setThreadLists,
    setOpenThreadIds: threadLists.setOpenThreadIds,
    setSelectedAgentId,
    cancelThreadConfirmDelete,
    advanceDraftNonceAfterSessionGone: launcher.advanceDraftNonceAfterSessionGone,
  });

  return {
    key, launcher, lifecycle, threadLists, threadError, selectedAgentId, historyLoadedFor,
    threadModelIds, loadingHistoryFor,
  };
}

describe('closeThread render-time closure staleness via concurrent reopenClosedThread (bdboard-ygrg)', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchChatThreadsMock.mockReset();
    deleteChatThreadMock.mockReset();
  });

  it('does not silently drop a thread reopened while a delete is still in flight', async () => {
    writePersistedChatThreadState('project-a', {
      activeSessionIds: ['sess-1', 'sess-2'],
      selectedSessionId: 'sess-1',
    });
    fetchChatThreadsMock.mockResolvedValue([
      thread('sess-1', 'one'),
      thread('sess-2', 'two'),
      thread('sess-3', 'three'),
    ]);
    let resolveDelete: (() => void) | undefined;
    deleteChatThreadMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );

    const { result } = renderHook(() => useProbe('project-a'));
    await waitFor(() =>
      expect(result.current.threadLists.openThreadIds['project-a']).toEqual(['sess-1', 'sess-2']),
    );

    // ユーザーが sess-1 の削除を確定する。deleteThread は deleteChatThread の
    // resolve を待ってから closeThread(sessionId) を呼ぶ(async 関数の続き)。
    // ここではまだ resolve していない(ネットワーク往復の途中)。
    act(() => {
      void result.current.threadLists.deleteThread('sess-1');
    });

    // delete が in-flight の間に、ユーザーは別の閉じたスレッド sess-3 を
    // 普通に(同期 onClick で)reopen する。force-ordering は不要 — 実際の
    // ネットワーク待ちの間に別の操作が挟まる、というだけの自然な操作列。
    act(() => {
      result.current.threadLists.reopenClosedThread('sess-3');
    });
    expect(result.current.threadLists.openThreadIds['project-a']).toEqual(['sess-1', 'sess-2', 'sess-3']);
    expect(result.current.key.selectedThreadIds['project-a']).toBe('sess-3');

    // delete が解決し、closeThread の続きが走る。
    await act(async () => {
      resolveDelete?.();
    });

    // 修正前の壊れ方: closeThread(deleteThread の継続として呼ばれた方)は
    // deleteThread が定義された render の openThreads クロージャ
    // (['sess-1','sess-2'] — reopen 前のスナップショット)を見て
    // next = ['sess-2'] を計算し、setOpenThreadIds で丸ごと上書きする。
    // reopen で追加したはずの sess-3 が跡形もなく消える(黙った巻き戻り)。
    expect(result.current.threadLists.openThreadIds['project-a']).toEqual(['sess-2', 'sess-3']);
  });
});
