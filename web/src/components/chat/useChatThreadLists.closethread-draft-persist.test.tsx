import { act, renderHook, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../../chatThreadStorage';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    fetchChatThreads: vi.fn(),
    acknowledgeChatTurn: vi.fn(() => Promise.resolve()),
    deleteChatThread: vi.fn(),
  };
});

import { fetchChatThreads } from '../../api';
import { useChatSessionLifecycle } from './useChatSessionLifecycle';
import { useChatThreadLists } from './useChatThreadLists';
import { useConversationKey } from './useConversationKey';
import { useDraftThreadLauncher } from './useDraftThreadLauncher';
import { useThreadListSync } from './useThreadListSync';

const fetchChatThreadsMock = vi.mocked(fetchChatThreads);

function thread(
  sessionId: string,
  title: string,
  updatedAt = '2026-01-01T00:00:00.000Z',
): ChatThreadDto {
  return { sessionId, agentId: 'agent-a', title, pinned: false, updatedAt };
}

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
  return { key, launcher, lifecycle, threadLists, threadError, selectedAgentId, historyLoadedFor,
    threadModelIds, loadingHistoryFor };
}

describe('closeThread preserves persisted selection while a draft is displayed (bdboard-e5cz)', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchChatThreadsMock.mockReset();
  });

  it('keeps the persisted selected session when closing another thread from a draft', async () => {
    // sess-1 が永続化済みの選択、sess-2 は sess-1 より新しい(=表示順の先頭に来る)
    // ことをわざと選び、「閉じた後の表示順の先頭 (nextDisplayed[0] = sess-2)」と
    // 「本来引き継ぐべき永続化済みの選択 (sess-1)」が一致しないようにしている。
    // こうしておかないと、たまたま両者が同じ値になり、fallback へ丸ごと
    // フォールバックしてしまう回帰(mutation)を検出できない。
    writePersistedChatThreadState('project-a', {
      activeSessionIds: ['sess-1', 'sess-2', 'sess-3'],
      selectedSessionId: 'sess-1',
    });
    fetchChatThreadsMock.mockResolvedValue([
      thread('sess-1', 'one', '2026-01-01T00:00:00.000Z'),
      thread('sess-2', 'two', '2026-01-03T00:00:00.000Z'),
      thread('sess-3', 'three', '2026-01-05T00:00:00.000Z'),
    ]);

    const { result } = renderHook(() => useProbe('project-a'));
    await waitFor(() =>
      expect(result.current.threadLists.openThreadIds['project-a']).toEqual(['sess-1', 'sess-2', 'sess-3']),
    );
    expect(result.current.key.selectedThreadIds['project-a']).toBe('sess-1');

    act(() => {
      result.current.launcher.startNewDraftThread('project-a');
    });
    expect(result.current.key.selectedThreadIds['project-a']).toBeUndefined();
    expect(readPersistedChatThreads()['project-a']?.selectedSessionId).toBe('sess-1');

    // sess-1(選択中として永続化済み)でも自分自身でもない、無関係な sess-3 を閉じる。
    act(() => {
      result.current.threadLists.closeThread('sess-3');
    });

    expect(result.current.threadLists.openThreadIds['project-a']).toEqual(['sess-1', 'sess-2']);
    expect(readPersistedChatThreads()['project-a']?.activeSessionIds).toEqual(['sess-1', 'sess-2']);
    // 修正前の壊れ方: ここが undefined になる(liveSelectedSessionId をそのまま
    // 永続化していたため)。表示順の先頭 sess-2 でもなく、永続化済みの sess-1 の
    // ままであるべき。
    expect(readPersistedChatThreads()['project-a']?.selectedSessionId).toBe('sess-1');
    expect(result.current.key.selectedThreadIds['project-a']).toBeUndefined();
  });
});
