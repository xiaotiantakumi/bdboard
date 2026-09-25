// bdboard-dqbz: closeThread が deleteThread の async 継続から呼ばれる間に
// threadLists が更新されても、フォールバック選択先を最新メタデータで並べる。
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

import { deleteChatThread, fetchChatThreads } from '../../api';
import { useChatSessionLifecycle } from './useChatSessionLifecycle';
import { useChatThreadLists } from './useChatThreadLists';
import { useConversationKey } from './useConversationKey';
import { useDraftThreadLauncher } from './useDraftThreadLauncher';
import { useThreadListSync } from './useThreadListSync';

const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const deleteChatThreadMock = vi.mocked(deleteChatThread);

function thread(sessionId: string, title: string, updatedAt: string): ChatThreadDto {
  return { sessionId, agentId: 'agent-a', title, pinned: false, updatedAt };
}

/** Probe follows the production composition used by useChatThreadLists.closethread-closure-race.test.tsx. */
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

describe('closeThread fallback sort uses live thread metadata (bdboard-dqbz)', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchChatThreadsMock.mockReset();
    deleteChatThreadMock.mockReset();
  });

  it('selects the newest remaining thread after thread metadata updates during delete', async () => {
    writePersistedChatThreadState('project-a', {
      activeSessionIds: ['sess-1', 'sess-2', 'sess-3'],
      selectedSessionId: 'sess-1',
    });
    fetchChatThreadsMock.mockResolvedValue([
      thread('sess-1', 'one', '2026-01-05T00:00:00.000Z'),
      thread('sess-2', 'two', '2026-01-03T00:00:00.000Z'),
      thread('sess-3', 'three', '2026-01-01T00:00:00.000Z'),
    ]);
    let resolveDelete: (() => void) | undefined;
    deleteChatThreadMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );

    const { result } = renderHook(() => useProbe('project-a'));
    await waitFor(() =>
      expect(result.current.threadLists.openThreadIds['project-a']).toEqual(['sess-1', 'sess-2', 'sess-3']),
    );
    expect(result.current.key.selectedThreadIds['project-a']).toBe('sess-1');

    act(() => {
      void result.current.threadLists.deleteThread('sess-1');
    });
    act(() => {
      result.current.threadLists.setThreadLists((prev) => ({
        ...prev,
        'project-a': (prev['project-a'] ?? []).map((t) =>
          t.sessionId === 'sess-3' ? { ...t, updatedAt: '2026-01-10T00:00:00.000Z' } : t,
        ),
      }));
    });

    await act(async () => {
      await Promise.resolve();
      resolveDelete?.();
    });

    expect(result.current.threadLists.openThreadIds['project-a']).toEqual(['sess-2', 'sess-3']);
    // 修正前は deleteThread が握る古い threadById を使い、sess-3 より古い sess-2 を選んでしまう。
    expect(result.current.key.selectedThreadIds['project-a']).toBe('sess-3');
    const persisted = readPersistedChatThreads()['project-a'];
    expect(persisted?.activeSessionIds).toEqual(['sess-2', 'sess-3']);
    expect(persisted?.selectedSessionId).toBe('sess-3');
  });
});
