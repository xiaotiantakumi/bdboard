// bdboard-sso1.83 第14d段: useThreadListSync(スレッド一覧 effect = 設計書 §1c の E7)の
// Probe テスト。本物の useConversationKey / useChatConversationsState /
// useChatNotifications と組み合わせ、pending の無効化と消化、
// isExplicitDraftStillSelected、永続化済み選択の復元、失敗時の経路、request-id と
// cancelled のガード、依存配列を広げても再取得の契機が変わらないことを確かめる。
import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../../chatThreadStorage';
import { createThreadListFetchOrder } from './threadListFetchOrder';
import { useChatConversationsState } from './useChatConversationsState';
import { useChatNotifications } from './useChatNotifications';
import { useConversationKey } from './useConversationKey';
import { useThreadListSync } from './useThreadListSync';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, fetchChatThreads: vi.fn() };
});

import { fetchChatThreads } from '../../api';

const fetchChatThreadsMock = vi.mocked(fetchChatThreads);

function thread(sessionId: string): ChatThreadDto {
  return { sessionId, agentId: 'claude', title: sessionId, pinned: false, updatedAt: '2026-01-01T00:00:00Z' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

type PendingPrefill = { projectId: string; text: string } | null;

function useSyncProbe({ projectId, startNewDraftThread }: { projectId: string; startNewDraftThread: (id: string) => void }) {
  const key = useConversationKey(projectId);
  const conv = useChatConversationsState();
  const notifications = useChatNotifications();
  const [threadLists, setThreadLists] = useState<Record<string, ChatThreadDto[]>>({});
  const [openThreadIds, setOpenThreadIds] = useState<Record<string, string[]>>({});
  // bdboard-d7on: E7 の書き込み側は openThreadIdsRef も同期する(render-mirror の
  // 同期漏れ対策)。このテストは復元結果を openThreadIds state で検証しており、
  // ref 自体の値は読まないので、単純な useRef で足りる。
  const openThreadIdsRef = useRef<Record<string, string[]>>({});
  const pendingPrefillRef = useRef<PendingPrefill>(null);
  const pendingTicketDraftProjectRef = useRef<string | null>(null);
  // bdboard-4w2d: E7 と applyRecoveredTurn が共有する「一覧・open 復元済み」マーカー。
  const restoredProjectsRef = useRef<Set<string>>(new Set());
  // bdboard-z9mn: E7・採用の取り直し・回収が共有する、プロジェクトごとの fetch 開始順序。
  const [threadListOrder] = useState(createThreadListFetchOrder);
  useThreadListSync({
    selectedProjectId: projectId,
    setThreadError: notifications.setThreadError,
    pendingPrefillRef,
    pendingTicketDraftProjectRef,
    threadListRequestIdRef: conv.threadListRequestIdRef,
    draftNoncesRef: key.draftNoncesRef,
    selectedThreadIdsRef: key.selectedThreadIdsRef,
    setThreadLists,
    setOpenThreadIds,
    openThreadIdsRef,
    setSelectedThreadIds: key.setSelectedThreadIds,
    startNewDraftThread,
    restoredProjectsRef,
    threadListOrder,
  });
  return {
    key,
    conv,
    notifications,
    threadLists,
    setThreadLists,
    openThreadIds,
    openThreadIdsRef,
    pendingPrefillRef,
    pendingTicketDraftProjectRef,
    restoredProjectsRef,
    threadListOrder,
  };
}

function renderProbe(projectId = 'proj-a') {
  const startNewDraftThread = vi.fn();
  const rendered = renderHook(
    (props: { projectId: string }) => useSyncProbe({ projectId: props.projectId, startNewDraftThread }),
    { initialProps: { projectId } },
  );
  return { ...rendered, startNewDraftThread };
}

describe('useThreadListSync', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchChatThreadsMock.mockResolvedValue([thread('sess-1'), thread('sess-2')]);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('does nothing while no project is selected', async () => {
    const { result } = renderProbe('');
    await flush();
    expect(fetchChatThreadsMock).not.toHaveBeenCalled();
    expect(result.current.conv.threadListRequestIdRef.current).toBe(0);
  });

  it('stores the list, opens every thread and selects the first one when nothing is persisted', async () => {
    const { result } = renderProbe();
    await flush();
    expect(fetchChatThreadsMock.mock.calls).toEqual([['proj-a']]);
    expect(result.current.conv.threadListRequestIdRef.current).toBe(1);
    expect(result.current.threadLists['proj-a']?.map((t) => t.sessionId)).toEqual(['sess-1', 'sess-2']);
    expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-1', 'sess-2'] });
    expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-1' });
    // bdboard-4w2d: 復元を実際に行った後はマーカーを立てる。
    expect(result.current.restoredProjectsRef.current.has('proj-a')).toBe(true);
  });

  it('keeps only persisted ids the server still lists and restores the persisted selection', async () => {
    writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-gone', 'sess-2'], selectedSessionId: 'sess-2' });
    const { result } = renderProbe();
    await flush();
    expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-2'] });
    expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-2' });
  });

  it('invalidates pending intents for another project at the start of the run and keeps this project\'s', () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result, rerender } = renderProbe('');
    result.current.pendingTicketDraftProjectRef.current = 'proj-b';
    result.current.pendingPrefillRef.current = { projectId: 'proj-b', text: 'b' };
    rerender({ projectId: 'proj-a' });
    expect(result.current.pendingTicketDraftProjectRef.current).toBeNull();
    expect(result.current.pendingPrefillRef.current).toBeNull();

    result.current.pendingTicketDraftProjectRef.current = 'proj-b';
    result.current.pendingPrefillRef.current = { projectId: 'proj-b', text: 'b' };
    rerender({ projectId: 'proj-b' });
    expect(result.current.pendingTicketDraftProjectRef.current).toBe('proj-b');
    expect(result.current.pendingPrefillRef.current).toEqual({ projectId: 'proj-b', text: 'b' });
  });

  it('consumes a pending ticket draft for this project with one startNewDraftThread and no selection', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result, startNewDraftThread } = renderProbe();
    result.current.pendingTicketDraftProjectRef.current = 'proj-a';
    await act(async () => { list.resolve([thread('sess-1')]); await list.promise; });
    expect(result.current.pendingTicketDraftProjectRef.current).toBeNull();
    expect(startNewDraftThread.mock.calls).toEqual([['proj-a']]);
    expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-1'] });
    expect(result.current.key.selectedThreadIds).toEqual({});
  });

  it('leaves an explicit draft selected when the nonce moved while the fetch was in flight', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result, startNewDraftThread } = renderProbe();
    act(() => { result.current.key.setDraftNonces({ 'proj-a': 1 }); });
    await act(async () => { list.resolve([thread('sess-1')]); await list.promise; });
    expect(result.current.key.selectedThreadIds).toEqual({});
    expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-1'] });
    expect(startNewDraftThread).not.toHaveBeenCalled();
  });

  it('falls back to the unfiltered persisted state and reports the error when the fetch fails', async () => {
    writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-gone', 'sess-2'] });
    fetchChatThreadsMock.mockRejectedValue(new Error('down'));
    const { result } = renderProbe();
    await flush();
    await flush();
    expect(result.current.notifications.threadError).toBe('スレッド一覧の取得に失敗しました。');
    expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-gone', 'sess-2'] });
    expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-gone' });
  });

  it('uses the persisted state as of when the response arrives, not a stale snapshot from when the fetch started (bdboard-4w2d)', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    // 効果開始の時点で、永続化は sess-2 だけを開いている(再訪)。
    writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-2'], selectedSessionId: 'sess-2' });
    const { result } = renderProbe();
    // fetch が in-flight の間に別経路(useChatSendCommits.ts の送信成功に相当)が永続化を書き込む —
    // 以前はここで effect 開始時に読んだ古いスナップショット(sess-2)を使い続けていたため、
    // この書き込みを取りこぼしていた。
    act(() => {
      writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
    });
    await act(async () => { list.resolve([thread('sess-1'), thread('sess-2')]); await list.promise; });
    expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-1'] });
    expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-1' });
    expect(result.current.restoredProjectsRef.current.has('proj-a')).toBe(true);
  });

  it('opens the whole list on a first visit even though the persisted entry appeared during the fetch (bdboard-4w2d, bdboard-0206)', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result } = renderProbe();
    // 効果開始の時点ではまだ何も永続化されていない(初回訪問)。in-flight の間に最初のエントリが書かれる。
    // bdboard-4w2d 当時はこの書き込みを正本にして [sess-1] だけを開いていた。bdboard-0206 以降は、書き込まれた
    // sess-1 を取りこぼさないまま、サーバー一覧の sess-2 も開く(初回訪問は全スレッドを開く既定則のまま)。
    act(() => {
      writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
    });
    await act(async () => { list.resolve([thread('sess-1'), thread('sess-2')]); await list.promise; });
    expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-1', 'sess-2'] });
    expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-1' });
    expect(result.current.restoredProjectsRef.current.has('proj-a')).toBe(true);
  });

  it('falls back to the persisted state as of when the failure arrives, not a stale snapshot (bdboard-4w2d)', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result } = renderProbe();
    act(() => {
      writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-9'], selectedSessionId: 'sess-9' });
    });
    await act(async () => { list.reject(new Error('down')); await list.promise.catch(() => undefined); });
    expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-9'] });
    expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-9' });
    expect(result.current.restoredProjectsRef.current.has('proj-a')).toBe(true);
  });

  it('does not overwrite openThreadIds when another writer already established this project\'s state before the fetch resolves (bdboard-4w2d, Opus レビュー blocker 2 対応)', async () => {
    // 例: エージェント切替(handleAgentChange の明示的リセット)や、先に完了した
    // turn-status 回収の hydrate が、この fetch の in-flight 中に既にこのプロジェクトの
    // open/選択を確立してマーク済みだったとする。E7 は「持っている情報を足し合わせる」
    // のではなく「これが正しい状態そのもの」という確定的な確立を上書きしてはならない —
    // ここで上書きすると、persisted が(handleAgentChange により)未設定のまま
    // restoreThreadView に渡り、「永続化が無い ⇒ 全スレッドを開く」既定則に従って
    // 意図的な空状態へ全スレッドを再展開してしまう。
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result, startNewDraftThread } = renderProbe();
    act(() => {
      result.current.restoredProjectsRef.current.add('proj-a');
    });
    result.current.pendingTicketDraftProjectRef.current = 'proj-a';
    await act(async () => { list.resolve([thread('sess-1'), thread('sess-2')]); await list.promise; });
    expect(result.current.openThreadIds).toEqual({});
    expect(result.current.key.selectedThreadIds).toEqual({});
    // pending なチケット起動ドラフトの消化は、この応答でしか担えないので続く。
    expect(startNewDraftThread.mock.calls).toEqual([['proj-a']]);
    expect(result.current.pendingTicketDraftProjectRef.current).toBeNull();
  });

  it('does not overwrite openThreadIds on the failure path either, when another writer already established this project\'s state (bdboard-4w2d, Opus レビュー blocker 2 対応)', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result, startNewDraftThread } = renderProbe();
    act(() => {
      result.current.restoredProjectsRef.current.add('proj-a');
    });
    result.current.pendingTicketDraftProjectRef.current = 'proj-a';
    await act(async () => { list.reject(new Error('down')); await list.promise.catch(() => undefined); });
    expect(result.current.openThreadIds).toEqual({});
    expect(result.current.key.selectedThreadIds).toEqual({});
    expect(startNewDraftThread.mock.calls).toEqual([['proj-a']]);
  });

  it('keeps the list entries of open tabs when another writer established the project and refreshed the list before the stale fetch resolves (bdboard-znnl)', async () => {
    // 採用(handleResumeDiscoveredSession)が open と一覧を先に確立し、その後で採用より前に始まった
    // 古い初回の応答が届く。応答には sess-new が無いが、開いているタブのエントリは残す。
    // 開いていない古いエントリ(sess-closed)は応答に無ければ落とす。
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result } = renderProbe();
    act(() => {
      result.current.restoredProjectsRef.current.add('proj-a');
      result.current.openThreadIdsRef.current = { 'proj-a': ['sess-1', 'sess-new'] };
      result.current.setThreadLists({
        'proj-a': [thread('sess-1'), thread('sess-new'), thread('sess-closed')],
      });
    });
    await act(async () => { list.resolve([thread('sess-1'), thread('sess-2')]); await list.promise; });
    expect(result.current.threadLists['proj-a']?.map((t) => t.sessionId)).toEqual(['sess-1', 'sess-2', 'sess-new']);
    // open と選択は復元し直さない(既存の bdboard-4w2d の振る舞いのまま)。
    expect(result.current.openThreadIds).toEqual({});
    expect(result.current.key.selectedThreadIds).toEqual({});
  });

  it('applies the response as-is when another writer established the project but no list was written yet (bdboard-znnl)', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result } = renderProbe();
    act(() => {
      result.current.restoredProjectsRef.current.add('proj-a');
      result.current.openThreadIdsRef.current = { 'proj-a': ['sess-new'] };
    });
    await act(async () => { list.resolve([thread('sess-1')]); await list.promise; });
    expect(result.current.threadLists['proj-a']?.map((t) => t.sessionId)).toEqual(['sess-1']);
  });

  it('replaces a previous visit\'s list outright when no other writer established the project (bdboard-znnl)', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result } = renderProbe();
    act(() => {
      result.current.openThreadIdsRef.current = { 'proj-a': ['sess-old'] };
      result.current.setThreadLists({ 'proj-a': [thread('sess-old')] });
    });
    await act(async () => { list.resolve([thread('sess-1')]); await list.promise; });
    expect(result.current.threadLists['proj-a']?.map((t) => t.sessionId)).toEqual(['sess-1']);
  });

  describe('thread-list fetch order (bdboard-z9mn)', () => {
    it('does not write a response that started before a list another writer already applied', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      // 採用の取り直し(E7 より後に始まった)の一覧が先に当たっている。
      act(() => {
        result.current.restoredProjectsRef.current.add('proj-a');
        result.current.openThreadIdsRef.current = { 'proj-a': ['sess-1', 'sess-new'] };
        const seq = result.current.threadListOrder.begin('proj-a');
        const applied = result.current.threadListOrder.admit('proj-a', seq, [thread('sess-1'), thread('sess-new')]);
        result.current.setThreadLists({ 'proj-a': applied ?? [] });
      });
      await act(async () => { list.resolve([thread('sess-1'), thread('sess-2')]); await list.promise; });
      // 古い一覧はそれを上書きしない(開いているタブのエントリを残す合成すら要らない)。
      expect(result.current.threadLists['proj-a']?.map((t) => t.sessionId)).toEqual(['sess-1', 'sess-new']);
      expect(result.current.openThreadIds).toEqual({});
    });

    it('lays an entry written after the fetch started over the response, and restores from that list', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      // 初回の一覧が in-flight の間に、ドラフトからの送信が成功した(マーカーは立てない)。永続化は新しい会話だけ。
      act(() => {
        result.current.threadListOrder.noteEntryWrite('proj-a', thread('sess-new'), 'upsert');
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
      });
      await act(async () => { list.resolve([thread('sess-1'), thread('sess-2')]); await list.promise; });
      expect(result.current.threadLists['proj-a']?.map((t) => t.sessionId)).toEqual(['sess-1', 'sess-2', 'sess-new']);
      // 応答に無い送信した会話を、復元で open と選択から落とさない。bdboard-0206 以降は、初回訪問なので
      // サーバー一覧の他のスレッドも開く(詳細は下の bdboard-0206 の describe)。
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-1', 'sess-2', 'sess-new'] });
      expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-new' });
    });

    it('lays a rename made after the fetch started over the response', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      act(() => {
        result.current.threadListOrder.noteEntryWrite('proj-a', { ...thread('sess-1'), title: 'renamed' }, 'replace');
      });
      await act(async () => { list.resolve([thread('sess-1'), thread('sess-2')]); await list.promise; });
      expect(result.current.threadLists['proj-a']?.map((t) => t.title)).toEqual(['renamed', 'sess-2']);
    });
  });

  describe('a thread deleted while the list is in flight (bdboard-gtv0)', () => {
    it('does not bring the deleted thread back to the list or the open tabs, and admits the response exactly once', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      const admit = vi.spyOn(result.current.threadListOrder, 'admit');
      // 初回の一覧が in-flight の間に sess-2 が削除された(useChatThreadLists の deleteThread 相当: forgetEntry)。
      act(() => {
        result.current.threadListOrder.forgetEntry('proj-a', 'sess-2');
      });
      // サーバーの応答は削除前の状態を映していて sess-2 を載せている。
      await act(async () => { list.resolve([thread('sess-1'), thread('sess-2'), thread('sess-3')]); await list.promise; });
      expect(result.current.threadLists['proj-a']?.map((t) => t.sessionId)).toEqual(['sess-1', 'sess-3']);
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-1', 'sess-3'] });
      expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-1' });
      // E7 は 1 fetch につき admit を 1 回だけ呼ぶ(同じ番号の二重 admit が起きない)。
      expect(admit.mock.calls.map((call) => call[1])).toEqual([1]);
    });

    it('trusts a response that started after the delete', async () => {
      const first = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValueOnce(first.promise);
      const { result, rerender } = renderProbe();
      act(() => {
        result.current.threadListOrder.forgetEntry('proj-a', 'sess-2');
      });
      // 別のプロジェクトへ移って戻ると、新しい E7 の fetch が始まる(削除より後の開始番号)。
      const second = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValueOnce(new Promise(() => {})).mockReturnValueOnce(second.promise);
      rerender({ projectId: 'proj-b' });
      rerender({ projectId: 'proj-a' });
      await act(async () => { second.resolve([thread('sess-1'), thread('sess-2')]); await second.promise; });
      expect(result.current.threadLists['proj-a']?.map((t) => t.sessionId)).toEqual(['sess-1', 'sess-2']);
    });
  });

  describe('first visit whose first persisted entry is written while the list is in flight (bdboard-0206)', () => {
    const SERVER_LIST = [thread('sess-a'), thread('sess-b'), thread('sess-c')];

    it('opens the whole server list plus a session sent from the draft during the fetch, and persists that set', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      // 永続化エントリの無い初回訪問。一覧が in-flight の間に、ドラフトからの送信が成功して最初のエントリを書く
      // (commitSuccess 相当: 未復元なのでマーカーは立てず、一覧の順序管理に upsert を記録する)。
      act(() => {
        result.current.threadListOrder.noteEntryWrite('proj-a', thread('sess-new'), 'upsert');
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
      });
      await act(async () => { list.resolve(SERVER_LIST); await list.promise; });
      // 永続化の [sess-new] だけに潰さず、サーバー一覧 [A,B,C] と送信した会話の和で開く。
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-a', 'sess-b', 'sess-c', 'sess-new'] });
      expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-new' });
      // 永続化もメモリの open と揃える(でないとリロードで A/B/C が黙って閉じられる)。
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-c', 'sess-new'],
        selectedSessionId: 'sess-new',
      });
      expect(result.current.restoredProjectsRef.current.has('proj-a')).toBe(true);
    });

    it('adds the whole server list to a session adopted during the fetch, without touching the selection', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      // 採用(handleResumeDiscoveredSession 相当)が、E7 より先に open と最初の永続化エントリを確立してマーカーを立てる。
      act(() => {
        result.current.restoredProjectsRef.current.add('proj-a');
        result.current.openThreadIdsRef.current = { 'proj-a': ['sess-new'] };
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
      });
      await act(async () => { list.resolve(SERVER_LIST); await list.promise; });
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-a', 'sess-b', 'sess-c', 'sess-new'] });
      // 選択は採用が確立したまま(E7 は書かない)。
      expect(result.current.key.selectedThreadIds).toEqual({});
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-c', 'sess-new'],
        selectedSessionId: 'sess-new',
      });
    });

    it('does not duplicate an adopted session the server list already carries', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      act(() => {
        result.current.restoredProjectsRef.current.add('proj-a');
        result.current.openThreadIdsRef.current = { 'proj-a': ['sess-b'] };
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-b'], selectedSessionId: 'sess-b' });
      });
      await act(async () => { list.resolve(SERVER_LIST); await list.promise; });
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-a', 'sess-b', 'sess-c'] });
    });

    it('widens an adopted open with the list already applied, not with a stale response that lists a deleted thread', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      // 採用が確立し、採用の取り直し(E7 より後に始まった)の一覧が先に当たっている。sess-2 はその間に削除されて載っていない。
      act(() => {
        result.current.restoredProjectsRef.current.add('proj-a');
        result.current.openThreadIdsRef.current = { 'proj-a': ['sess-new'] };
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
        const seq = result.current.threadListOrder.begin('proj-a');
        const applied = result.current.threadListOrder.admit('proj-a', seq, [thread('sess-1'), thread('sess-new')]);
        result.current.setThreadLists({ 'proj-a': applied ?? [] });
      });
      // 古い E7 の一覧(削除済みの sess-2 を載せている)が届く。応答は捨てられる(admit が undefined)。
      await act(async () => { list.resolve([thread('sess-1'), thread('sess-2')]); await list.promise; });
      // 古い一覧のデータを open と永続化に入れない: 入れると threadLists に無い (無題) のタブになる。
      expect(result.current.threadLists['proj-a']?.map((t) => t.sessionId)).toEqual(['sess-1', 'sess-new']);
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-1', 'sess-new'] });
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-1', 'sess-new'],
        selectedSessionId: 'sess-new',
      });
    });

    it('opens from the list already applied, not from a stale response, on the send path too', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      // 送信が最初のエントリを書いた(マーカーは立てない)。E7 より後に始まった一覧が先に当たっている(到達しにくい順序だが、
      // 古い応答の id を open と永続化に入れないことは経路によらず守る)。
      act(() => {
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
        const seq = result.current.threadListOrder.begin('proj-a');
        const applied = result.current.threadListOrder.admit('proj-a', seq, [thread('sess-1'), thread('sess-new')]);
        result.current.setThreadLists({ 'proj-a': applied ?? [] });
      });
      await act(async () => { list.resolve([thread('sess-1'), thread('sess-2')]); await list.promise; });
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-1', 'sess-new'] });
      expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toEqual(['sess-1', 'sess-new']);
    });

    it('keeps an explicit empty open from an agent change: its entry has no active ids', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      // handleAgentChange 相当: open を [] に確定させ、マーカーを立て、空のエントリを書く。
      act(() => {
        result.current.restoredProjectsRef.current.add('proj-a');
        result.current.openThreadIdsRef.current = { 'proj-a': [] };
        writePersistedChatThreadState('proj-a', { activeSessionIds: [], selectedSessionId: undefined });
      });
      await act(async () => { list.resolve(SERVER_LIST); await list.promise; });
      expect(result.current.openThreadIds).toEqual({});
      expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: [] });
    });

    it('still treats a persisted entry that existed when the fetch started as the source of truth', async () => {
      // 再訪: 開始時にエントリがある(sess-a だけ開いていた)。in-flight 中に送信で sess-new が足されても、
      // 閉じていた sess-b/sess-c は開き直さない。
      writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-a'], selectedSessionId: 'sess-a' });
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      act(() => {
        result.current.threadListOrder.noteEntryWrite('proj-a', thread('sess-new'), 'upsert');
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-a', 'sess-new'], selectedSessionId: 'sess-new' });
      });
      await act(async () => { list.resolve(SERVER_LIST); await list.promise; });
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-a', 'sess-new'] });
      expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-new' });
    });
  });

  it('consumes a pending ticket draft on the failure path too', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result, startNewDraftThread } = renderProbe();
    result.current.pendingTicketDraftProjectRef.current = 'proj-a';
    await act(async () => { list.reject(new Error('down')); await list.promise.catch(() => undefined); });
    expect(startNewDraftThread.mock.calls).toEqual([['proj-a']]);
    expect(result.current.key.selectedThreadIds).toEqual({});
  });

  it('drops the old project\'s response after switching projects', async () => {
    const listA = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValueOnce(listA.promise).mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderProbe();
    rerender({ projectId: 'proj-b' });
    await act(async () => { listA.resolve([thread('sess-a')]); await listA.promise; });
    expect(result.current.threadLists).toEqual({});
    expect(result.current.key.selectedThreadIds).toEqual({});
  });

  it('drops a response once another effect advanced the request id (E8, design §5 P1)', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result } = renderProbe();
    result.current.conv.threadListRequestIdRef.current += 1;
    await act(async () => { list.resolve([thread('sess-1')]); await list.promise; });
    expect(result.current.threadLists).toEqual({});
    expect(result.current.key.selectedThreadIds).toEqual({});
  });

  it('still consumes a pending ticket draft when a recovery hydrate advanced the request id (bdboard-tsen)', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result, startNewDraftThread } = renderProbe();
    result.current.pendingTicketDraftProjectRef.current = 'proj-a';
    result.current.conv.threadListRequestIdRef.current += 1;
    await act(async () => { list.resolve([thread('sess-1')]); await list.promise; });
    expect(startNewDraftThread.mock.calls).toEqual([['proj-a']]);
    expect(result.current.pendingTicketDraftProjectRef.current).toBeNull();
    // 一覧・open・選択は回収側が当てたものを残す。
    expect(result.current.threadLists).toEqual({});
    expect(result.current.openThreadIds).toEqual({});
    expect(result.current.key.selectedThreadIds).toEqual({});
  });

  it('still consumes a pending ticket draft on a superseded failure without reporting the error (bdboard-tsen)', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result, startNewDraftThread } = renderProbe();
    result.current.pendingTicketDraftProjectRef.current = 'proj-a';
    result.current.conv.threadListRequestIdRef.current += 1;
    await act(async () => { list.reject(new Error('down')); await list.promise.catch(() => undefined); });
    expect(startNewDraftThread.mock.calls).toEqual([['proj-a']]);
    expect(result.current.notifications.threadError).toBeNull();
    expect(result.current.openThreadIds).toEqual({});
  });

  it('does not consume a pending ticket draft after unmount (cancelled)', async () => {
    const list = deferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockReturnValue(list.promise);
    const { result, unmount, startNewDraftThread } = renderProbe();
    const pendingRef = result.current.pendingTicketDraftProjectRef;
    pendingRef.current = 'proj-a';
    unmount();
    await act(async () => { list.resolve([thread('sess-1')]); await list.promise; });
    expect(startNewDraftThread).not.toHaveBeenCalled();
    expect(pendingRef.current).toBe('proj-a');
  });

  it('re-syncs open/selected from the fresh list on a revisit, instead of getting stuck at the first visit\'s snapshot (bdboard-4w2d, 2巡目 Opus レビュー指摘対応)', async () => {
    // restoredProjectsRef はプロジェクトIDをキーにした Set で、どこからも
    // delete/clear されない(ChatPanel がマウントされている限り一度立ったら残る)。
    // ガード(「既にマーク済みならこの応答での復元をスキップする」)がこの effect の
    // 開始時にマーカーを下ろさないと、一度でも復元したプロジェクトへ再訪するたびに
    // 新しく始まる fetch サイクルもマーク済みと誤認し、E7 自身の復元が二度と
    // 走らなくなる(離れている間に他タブでスレッドが削除・追加されても再訪時の
    // open/選択に反映されない退行)。
    fetchChatThreadsMock.mockResolvedValueOnce([thread('sess-1'), thread('sess-2')]);
    const { result, rerender } = renderProbe('proj-a');
    await flush();
    expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-1', 'sess-2'] });
    expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-1' });
    expect(result.current.restoredProjectsRef.current.has('proj-a')).toBe(true);

    // proj-b へ離脱している間に proj-a では sess-1 が消え、sess-3 が増えたとする。
    fetchChatThreadsMock.mockResolvedValueOnce([thread('sess-b')]);
    rerender({ projectId: 'proj-b' });
    await flush();

    fetchChatThreadsMock.mockResolvedValueOnce([thread('sess-2'), thread('sess-3')]);
    rerender({ projectId: 'proj-a' });
    await flush();

    expect(result.current.openThreadIds).toMatchObject({ 'proj-a': ['sess-2', 'sess-3'] });
    expect(result.current.key.selectedThreadIds).toMatchObject({ 'proj-a': 'sess-2' });
  });

  it('refetches only when the project changes, not on unrelated re-renders or nonce/selection updates', async () => {
    // startNewDraftThread はここでは固定の vi.fn なので、本物の参照安定性は見ていない。
    // それは ChatPanel.reassignment-characterization.test.tsx の 14d と
    // useDraftThreadLauncher.test.tsx の参照安定性テストが押さえる。
    const { result, rerender } = renderProbe();
    await flush();
    act(() => { result.current.key.setDraftNonces({ 'proj-a': 2 }); });
    act(() => { result.current.key.setSelectedThreadIds({ 'proj-a': 'sess-2' }); });
    rerender({ projectId: 'proj-a' });
    await flush();
    expect(fetchChatThreadsMock.mock.calls).toEqual([['proj-a']]);
    rerender({ projectId: 'proj-b' });
    await flush();
    expect(fetchChatThreadsMock.mock.calls).toEqual([['proj-a'], ['proj-b']]);
  });
});
