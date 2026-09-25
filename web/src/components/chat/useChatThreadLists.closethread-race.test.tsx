// bdboard-197q: bdboard-d7on(PR #792、Opus レビュー B1/M1 対応)で
// selectedThreadIdsRef の同期漏れを直したが、grep で洗い出した残り3箇所
// (chat/useChatThreadLists.ts の closeThread/selectOpenThread/
// reopenClosedThread)は「既知の同 tick 競合相手が無い」として bdboard-d7on の
// スコープ外にした。このファイルはその判定を実地で検証する — 3箇所のうち
// closeThread だけは deleteThread 経由で呼ばれる場合がある:
//
//   const deleteThread = async (sessionId) => {
//     await deleteChatThread(sessionId, selectedProjectId);  // ← ここで一度
//                                                                microtask へ戻る
//     closeThread(sessionId);                                // ← await の続き
//     ...                                                        (promise の
//   };                                                            継続、つまり
//                                                                  同期クリック
//                                                                  ディスパッチの
//                                                                  外)
//
// deleteChatThread の resolve は closeThread(と、選択中スレッドを削除した場合の
// setSelectedThreadIds)を「独立した非同期処理の続き」として実行する。これは
// bdboard-d7on で直した commitSuccess/E7 の restore/handleResumeDiscoveredSession
// と同じ形(async resolve → setState)で、turn-status 回収の hydrate
// (applyRecoveredTurn、これも別の async resolve)が同じ flush で連続すれば
// 同 tick 競合になり得る。selectOpenThread/reopenClosedThread にはこの経路が無い
// (grep 済み: onClick から直接呼ばれる同期ハンドラのみで、promise の継続として
// 呼ばれる経路が存在しない)。
//
// なぜ selectOpenThread/reopenClosedThread は「今のところ」安全と言えるか:
// このリポジトリは React 19.1.0 (web/package.json で確認済み)。React 19 は
// state 更新のある同期ハンドラの「最初の setState」の時点でレンダーを
// microtask としてキューする。ユーザークリックは空の microtask queue から
// 始まるため、その最初の setState より後にキューされる microtask (他ハンドラの
// async 継続を含む)は、既にキュー済みのレンダー(→ ref 再同期)より後に実行され、
// 常に最新の ref を読む。逆に最初の setState より前に microtask を挟むハンドラ
// (例: 先頭に await を足す将来の変更)ではこの保護は崩れる。詳細と両ハンドラの
// コード側コメントは useChatThreadLists.ts の selectOpenThread/reopenClosedThread
// 定義直前を参照。reopenClosedThread 側にはさらに別種の closure-staleness
// (render-time openThreads 依存)があり、これは follow-up bdboard-ygrg で
// closeThread 側とあわせて追跡している。
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionMessagesDto, ChatThreadDto } from '../../api';
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

const RECOVERED: ChatSessionMessagesDto = {
  sessionId: 'sess-rec',
  agentId: 'agent-b',
  model: 'model-2',
  messages: [{ role: 'assistant', content: 'recovered', createdAt: '2026-08-18T12:00:00.000Z' }],
};

/**
 * chat/useChatPanelStores.ts → useChatPanelAgentAndLauncher.ts → useChatPanelSync.ts
 * が実際に組み立てる順序をそのまま踏む probe。useChatSessionLifecycle.selectedthread-race.test.tsx
 * の useProbe と違い、openThreadIds/restoredProjectsRef/threadLists を別の useState で
 * 作らず、useChatThreadLists(本番と同じ唯一の所有者)の戻り値をそのまま他フックへ渡す
 * — closeThread/deleteThread を実際に呼ぶには、この一貫性が要る。
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

describe('selectedThreadIdsRef render-mirror race via closeThread/deleteThread (bdboard-197q)', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchChatThreadsMock.mockReset();
    deleteChatThreadMock.mockReset();
  });

  it('falls back to the remaining thread, not the just-deleted one, when turn-status recovery hydrates in the same tick as deleteThread resolving', async () => {
    writePersistedChatThreadState('project-a', {
      activeSessionIds: ['sess-1', 'sess-2'],
      selectedSessionId: 'sess-1',
    });
    fetchChatThreadsMock.mockResolvedValue([thread('sess-1', 'one'), thread('sess-2', 'two')]);
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
    expect(result.current.key.selectedThreadIds['project-a']).toBe('sess-1');

    // ユーザーが選択中のスレッド(sess-1)の削除を確定する。deleteThread は
    // deleteChatThread の resolve を待ってから closeThread(sessionId) を呼ぶ
    // (async 関数の続き = promise の継続)。
    act(() => {
      void result.current.threadLists.deleteThread('sess-1');
    });

    await act(async () => {
      // 削除 API が解決し、closeThread の続きが走る(open から sess-1 を除き、
      // 選択中だったので表示順で次のスレッド sess-2 へフォールバックする)が、
      // 再レンダーはまだ挟まない。同じ flush の中で turn-status 回収の hydrate
      // (別の async resolve)が届く。
      resolveDelete?.();
      await Promise.resolve();
      result.current.lifecycle.applyRecoveredTurn(
        [thread('sess-2', 'two'), thread('sess-rec', 'recovered')],
        RECOVERED,
      );
    });

    // 修正前の壊れ方: closeThread は openThreadIdsRef は同期するが
    // selectedThreadIdsRef は同期しない。直後の applyRecoveredTurn が読む
    // selectedThreadIdsRef.current はまだ削除前の sess-1 のまま(render-mirror
    // が1レンダー遅れる)なので、alreadyRestored 分岐(restoredProjectsRef 済み
    // かつ knownOpen 定義済み)では currentSelected が sess-1 のまま = たった今
    // 削除したはずのスレッドが選択に居座ってしまう(sess-2 へのフォールバックが
    // 無言で巻き戻る)。
    expect(result.current.threadLists.openThreadIds['project-a']).toEqual(['sess-2', 'sess-rec']);
    expect(result.current.key.selectedThreadIds['project-a']).toBe('sess-2');
  });
});
