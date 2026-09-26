// Regression matrix for render-mirror ref races.
//
// Each row keeps the originating bdboard ticket IDs next to the exact scenarios
// moved from the former per-bug files. The two probes mirror the production hook
// compositions while sharing setup across related rows.
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionMessagesDto, ChatThreadDto } from '../../api';
import {
  readPersistedChatThreads,
  writePersistedChatThreadState,
} from '../../chatThreadStorage';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    fetchChatThreads: vi.fn(() => new Promise<ChatThreadDto[]>(() => undefined)),
    acknowledgeChatTurn: vi.fn(() => Promise.resolve()),
    deleteChatThread: vi.fn(),
  };
});

import { deleteChatThread, fetchChatThreads } from '../../api';
import { makeDraftKey } from './draftKey';
import { useChatSendCommits } from './useChatSendCommits';
import { useChatSessionLifecycle } from './useChatSessionLifecycle';
import { useChatThreadLists } from './useChatThreadLists';
import { useConversationKey } from './useConversationKey';
import { useDraftThreadLauncher } from './useDraftThreadLauncher';
import { useThreadListSync } from './useThreadListSync';

const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const deleteChatThreadMock = vi.mocked(deleteChatThread);

function thread(
  sessionId: string,
  title: string,
  updatedAt = '2026-01-01T00:00:00.000Z',
): ChatThreadDto {
  return { sessionId, agentId: 'agent-a', title, pinned: false, updatedAt };
}

const RECOVERED: ChatSessionMessagesDto = {
  sessionId: 'sess-rec',
  agentId: 'agent-b',
  model: 'model-2',
  messages: [{ role: 'assistant', content: 'recovered', createdAt: '2026-08-18T12:00:00.000Z' }],
};


function useThreadListsProbe(projectId: string) {
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

  const commits = useChatSendCommits({
    selectedProjectId: projectId,
    showModelSelect: false,
    effectiveModelId: '',
    setConversations: setConversations as never,
    setHistoryLoadedFor,
    setThreadModelIds,
    setThreadLists: threadLists.setThreadLists,
    setOpenThreadIds: threadLists.setOpenThreadIds,
    openThreadIdsRef: threadLists.openThreadIdsRef,
    setSelectedThreadIds: key.setSelectedThreadIds,
    selectedThreadIdsRef: key.selectedThreadIdsRef,
    conversationInputsRef,
    conversationAttachmentsRef,
    setInput,
    updateConversationAttachments,
  });

  return {
    commits,
    key,
    launcher,
    lifecycle,
    openThreadIds: threadLists.openThreadIds,
    openThreadIdsRef: threadLists.openThreadIdsRef,
    restoredProjectsRef: threadLists.restoredProjectsRef,
    threadLists,
    threadError,
    selectedAgentId,
    historyLoadedFor,
    threadModelIds,
    loadingHistoryFor,
  };
}

type RaceSuite = {
  tickets: string;
  name: string;
  register: () => void;
};

const raceSuites: RaceSuite[] = [
  // Reproduces bdboard-d29q.
  {
    tickets: 'bdboard-d29q',
    name: 'useDraftThreadLauncher + useChatSessionLifecycle: cross-hook draft/recovery race',
    register() {
      it('keeps a just-started ticket-launch draft selected when turn-status recovery lands in the same tick as startNewDraftThread, before the next render (force-ordering repro, no sleep)', () => {
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
      
          act(() => {
            // E7(chat/useThreadListSync.ts)の .then() が実際に行う順序をそのまま
            // 再現する: (1) 一覧を復元済みとしてマーク(plain ref なので同期的に反映)、
            // (2) 保留中のチケット起動ドラフトを startNewDraftThread で開始
            // (consumePendingTicketDraft の中身そのもの)。
            result.current.restoredProjectsRef.current.add('project-a');
            result.current.launcher.startNewDraftThread('project-a');
            // (3) その直後、再レンダーを1度も挟まないまま turn-status 回収の hydrate が
            // 届く(chat/useTurnStatusRecovery.ts 経由の applyRecoveredTurn)。まだ
            // サーバー一覧に載っていなかった段階の一覧に回収セッションが増えて返る想定。
            result.current.lifecycle.applyRecoveredTurn(
              [
                thread('sess-1', 'first thread'),
                thread('sess-2', 'second thread'),
                thread('sess-rec', 'recovered thread'),
              ],
              RECOVERED,
            );
          });
      
          // 表示中のチケット起動ドラフトの選択(undefined)が、無言で回収セッションや
          // restoreThreadView の既定選択(先頭スレッド 'sess-1')へ上書きされていないこと。
          //
          // 修正前(bdboard-d29q 未修正)の実際の壊れ方: draftNoncesRef/
          // selectedThreadIdsRef が render-mirror のまま(次の再レンダーまで
          // startNewDraftThread の更新に追いつかない)ので、applyRecoveredTurn の
          // isExplicitDraftStillSelected が「ドラフトはまだ無い」と誤判定し、選択は
          // 永続化が無い新規プロジェクトの既定則(restoreThreadView: 永続化が無ければ
          // 先頭スレッドを選ぶ)に従って 'sess-1' に倒れる。
          expect(result.current.key.selectedThreadIds['project-a']).toBeUndefined();
          expect(result.current.key.draftNonces['project-a']).toBe(1);
        });
      
        it('keeps a just-started ticket-launch draft selected even when the project was already restored with a different thread selected (P1: revisit, not a fresh/unpersisted project)', () => {
          // bdboard-d29q Opus レビュー(finding 1): 最初のテストはプロジェクトが未復元
          // (persisted state 無し)の場合しか踏まない。より典型的な「以前から開いている
          // プロジェクトで、別スレッドが選択された状態からチケット起動する」経路
          // (alreadyRestored=true, currentSelected が restored?.selected ではなく
          // selectedThreadIdsRef.current の既存値そのものになる経路)は未検証だった。
          // このテストはその経路を踏む。
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
      
          act(() => {
            // このプロジェクトはすでに E7 で復元済み(restoredProjectsRef に登録済みかつ
            // openThreadIdsRef.current が populated)で、'sess-old' が選択されている
            // ―― という「直前のレンダーまでに確定していた状態」を、ref を直接書いて
            // 再現する(ref 自体への代入は再レンダーを起こさないので、この act() の中では
            // 何も反映されず、次の act() まで static に残る。本物の env では、この状態は
            // 実際の以前のレンダーが作る)。
            result.current.restoredProjectsRef.current.add('project-a');
            result.current.openThreadIdsRef.current = { 'project-a': ['sess-old'] };
            result.current.key.selectedThreadIdsRef.current = { 'project-a': 'sess-old' };
          });
      
          act(() => {
            // チケット起動でドラフトを開始した直後、再レンダーを挟まずに turn-status
            // 回収が届く(1つ目のテストと同じ force ordering)。
            result.current.launcher.startNewDraftThread('project-a');
            result.current.lifecycle.applyRecoveredTurn(
              [thread('sess-old', 'old thread'), thread('sess-rec', 'recovered thread')],
              RECOVERED,
            );
          });
      
          // 修正前の壊れ方(このケース固有): alreadyRestored なので restoreThreadView は
          // 呼ばれず、currentSelected は selectedThreadIdsRef.current(まだ startNewDraftThread
          // の更新に追いついていない古い 'sess-old')をそのまま読む。isExplicitDraftStillSelected
          // も selectedThreadIdsRef.current !== undefined で誤って false になるため、
          // 選択は 'sess-1' のような一覧先頭ではなく、直前に見ていた 'sess-old' へ
          // 無言で戻ってしまう(1つ目のテストとは異なる壊れ方だが、原因は同じ)。
          expect(result.current.key.selectedThreadIds['project-a']).toBeUndefined();
          expect(result.current.key.draftNonces['project-a']).toBe(1);
        });
    },
  },
  // Reproduces bdboard-d29q / bdboard-d7on / bdboard-g8e7.
  {
    tickets: 'bdboard-d29q / bdboard-d7on / bdboard-g8e7',
    name: 'openThreadIdsRef render-mirror race',
    register() {
      beforeEach(() => {
          localStorage.clear();
          fetchChatThreadsMock.mockReset();
        });
      
        afterEach(() => {
          vi.useRealTimers();
        });
      
        it('does not resurrect a session that handleHistorySessionGone just removed, when turn-status recovery hydrates in the same tick (P2, force-ordering repro, no sleep)', async () => {
          fetchChatThreadsMock.mockResolvedValue([thread('sess-dead', 'dead'), thread('sess-2', 'second')]);
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
      
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
      
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
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
    },
  },
  // Reproduces bdboard-d7on.
  {
    tickets: 'bdboard-d7on',
    name: 'selectedThreadIdsRef render-mirror race',
    register() {
      beforeEach(() => {
          localStorage.clear();
          fetchChatThreadsMock.mockReset();
        });
      
        it('keeps the just-committed session selected when turn-status recovery hydrates in the same tick as commitSuccess (M1)', async () => {
          fetchChatThreadsMock.mockResolvedValue([thread('sess-1', 'one')]);
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
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
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
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
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
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
    },
  },
  // Reproduces bdboard-197q / bdboard-e5cz / bdboard-ygrg.
  {
    tickets: 'bdboard-197q / bdboard-e5cz / bdboard-ygrg',
    name: 'closeThread render-time closure staleness via concurrent reopenClosedThread',
    register() {
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
      
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
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
            await Promise.resolve();
            resolveDelete?.();
          });
      
          // 修正前の壊れ方: closeThread(deleteThread の継続として呼ばれた方)は
          // deleteThread が定義された render の openThreads クロージャ
          // (['sess-1','sess-2'] — reopen 前のスナップショット)を見て
          // next = ['sess-2'] を計算し、setOpenThreadIds で丸ごと上書きする。
          // reopen で追加したはずの sess-3 が跡形もなく消える(黙った巻き戻り)。
          expect(result.current.threadLists.openThreadIds['project-a']).toEqual(['sess-2', 'sess-3']);
          expect(result.current.key.selectedThreadIds['project-a']).toBe('sess-3');
          const persisted = readPersistedChatThreads()['project-a'];
          expect(persisted?.activeSessionIds).toEqual(['sess-2', 'sess-3']);
          expect(persisted?.selectedSessionId).toBe('sess-3');
        });
      
        it('keeps selection cleared when a draft starts while delete is in flight', async () => {
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
      
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
          await waitFor(() =>
            expect(result.current.threadLists.openThreadIds['project-a']).toEqual(['sess-1', 'sess-2']),
          );
      
          act(() => {
            void result.current.threadLists.deleteThread('sess-1');
          });
          act(() => {
            result.current.launcher.startNewDraftThread('project-a');
          });
          expect(result.current.key.selectedThreadIds['project-a']).toBeUndefined();
      
          await act(async () => {
            await Promise.resolve();
            resolveDelete?.();
          });
      
          expect(result.current.key.selectedThreadIds['project-a']).toBeUndefined();
          // bdboard-e5cz(Opus レビュー指摘): この deleteThread 継続は closeThread('sess-1')
          // を呼び、sess-1 は「draft 開始前に永続化されていた選択」そのもの。next
          // (削除後の activeSessionIds = ['sess-2']) には sess-1 が含まれないので、
          // resolvePersistedSelectionAfterClose は sess-1 を dangling reference として
          // 扱いフォールバック(表示順の先頭 = sess-2)を選ぶべき。next の代わりに
          // 削除前の openThreadIds(sess-1 を含んだまま)を渡す退行が起きると、ここが
          // 'sess-2' ではなく 'sess-1'(既に削除済みのスレッド)のままになる。
          expect(readPersistedChatThreads()['project-a']?.activeSessionIds).toEqual(['sess-2']);
          expect(readPersistedChatThreads()['project-a']?.selectedSessionId).toBe('sess-2');
        });
    },
  },
  // Reproduces bdboard-e5cz.
  {
    tickets: 'bdboard-e5cz',
    name: 'closeThread preserves persisted selection while a draft is displayed',
    register() {
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
      
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
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
    },
  },
  // Reproduces bdboard-197q / bdboard-d7on / bdboard-ygrg.
  {
    tickets: 'bdboard-197q / bdboard-d7on / bdboard-ygrg',
    name: 'selectedThreadIdsRef render-mirror race via closeThread/deleteThread',
    register() {
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
      
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
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
      
        it('falls back to the newly recovered thread, not the just-deleted one, when it was the only open thread', async () => {
          writePersistedChatThreadState('project-a', {
            activeSessionIds: ['sess-1'],
            selectedSessionId: 'sess-1',
          });
          fetchChatThreadsMock.mockResolvedValue([thread('sess-1', 'one')]);
          let resolveDelete: (() => void) | undefined;
          deleteChatThreadMock.mockReturnValue(
            new Promise<void>((resolve) => {
              resolveDelete = resolve;
            }),
          );
      
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
          await waitFor(() =>
            expect(result.current.threadLists.openThreadIds['project-a']).toEqual(['sess-1']),
          );
          expect(result.current.key.selectedThreadIds['project-a']).toBe('sess-1');
      
          act(() => {
            void result.current.threadLists.deleteThread('sess-1');
          });
      
          await act(async () => {
            resolveDelete?.();
            await Promise.resolve();
            result.current.lifecycle.applyRecoveredTurn([thread('sess-rec', 'recovered')], RECOVERED);
          });
      
          // nextDisplayed[0] が undefined になる境界ケース。先にフォールバック候補が
          // openThreads にある場合だけ偶然通るのではなく、回収スレッドの選択も確認する。
          expect(result.current.threadLists.openThreadIds['project-a']).toEqual(['sess-rec']);
          expect(result.current.key.selectedThreadIds['project-a']).toBe('sess-rec');
        });
    },
  },
  // Reproduces bdboard-dqbz.
  {
    tickets: 'bdboard-dqbz',
    name: 'closeThread fallback sort uses live thread metadata',
    register() {
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
      
          const { result } = renderHook(() => useThreadListsProbe('project-a'));
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
    },
  },
];

describe.each(raceSuites)('$tickets: $name', ({ register }) => {
  register();
});


