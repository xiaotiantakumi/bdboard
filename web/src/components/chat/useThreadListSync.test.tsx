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
import { createProvisionalEntryMarks } from './provisionalEntry';
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
  // bdboard-rt6i: 仮のエントリ(未復元で最初の永続化エントリを書いた送信・採用)の印。E7 と回収が読み、復元で下ろす。
  const [provisionalEntries] = useState(() => createProvisionalEntryMarks((id) => restoredProjectsRef.current.has(id)));
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
    provisionalEntries,
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
    provisionalEntries,
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
    // その書き込みは送信成功の最初のエントリ(仮のエントリ。bdboard-rt6i 以降は送信が立てるマーカーで見分ける)。
    act(() => {
      result.current.provisionalEntries.markIfFirstEntry('proj-a');
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
      // 初回の一覧が in-flight の間に、ドラフトからの送信が成功した(restoredProjectsRef は立てず、仮のエントリの
      // マーカーは立てる)。永続化は新しい会話だけ。
      act(() => {
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
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
      // (commitSuccess 相当: 未復元で最初のエントリなので仮のエントリの印を立て、一覧の順序管理に upsert を記録する)。
      act(() => {
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
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
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
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
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
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
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
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
      // 送信が最初のエントリを書いた(仮のエントリの印が立つ)。E7 より後に始まった一覧が先に当たっている(到達しにくい順序だが、
      // 古い応答の id を open と永続化に入れないことは経路によらず守る)。
      act(() => {
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
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

  describe('a provisional first entry is told apart from the user\'s own record (bdboard-rt6i)', () => {
    const SERVER_LIST = [thread('sess-a'), thread('sess-b'), thread('sess-c')];

    it('treats a non-empty entry written during the fetch without the mark as the user\'s record, even when none existed at the start (gap 3)', async () => {
      // 前回訪問の open [A,B] がメモリに残ったまま永続化エントリが無い再訪。in-flight の間に利用者が B を閉じる
      // (closeThread 相当: エントリ [A] を書く。送信でも採用でもないのでマーカーは立たない)。
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      act(() => {
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-a'], selectedSessionId: 'sess-a' });
      });
      await act(async () => { list.resolve(SERVER_LIST); await list.promise; });
      // B を開き直さない: #852 以前と同じく、永続化が正本。
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-a'] });
      expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-a' });
      expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: ['sess-a'], selectedSessionId: 'sess-a' });
    });

    it('opens the server list but not a thread the user closed after a send wrote the provisional entry: closing keeps the mark', async () => {
      // 送信 N1 → 送信 N2 → N1 を閉じる。closeThread は永続化を [N2] にするが、印は下ろさず、閉じた N1 を覚える
      // (ここではその結果を再現する)。[N2] は利用者の記録ではないので、一度も見ていないサーバーの A/B/C も開く。
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      act(() => {
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
        result.current.threadListOrder.noteEntryWrite('proj-a', thread('sess-n1'), 'upsert');
        result.current.threadListOrder.noteEntryWrite('proj-a', thread('sess-n2'), 'upsert');
        result.current.provisionalEntries.noteClosed('proj-a', 'sess-n1');
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-n2'], selectedSessionId: 'sess-n2' });
      });
      await act(async () => { list.resolve(SERVER_LIST); await list.promise; });
      // 閉じた N1 は一覧(upsert の重ね合わせ)に載っても開かない。一覧には載る(閉じたスレッドとして出せる)。
      expect(result.current.threadLists['proj-a']?.map((t) => t.sessionId)).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-n1', 'sess-n2']);
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-a', 'sess-b', 'sess-c', 'sess-n2'] });
      expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-n2' });
      expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-n2']);
      // 復元したので、印と閉じた id の両方が下りる。
      expect(result.current.provisionalEntries.closedIds('proj-a').size).toBe(0);
    });

    it('opens the server list when the only provisional thread was closed: a marked empty entry is still provisional (R2)', async () => {
      // 送信 N1 → N1 を閉じる。closeThread は永続化を [] にするが、印は下ろさず N1 を覚える。[] は利用者の記録ではない。
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      act(() => {
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
        result.current.threadListOrder.noteEntryWrite('proj-a', thread('sess-n1'), 'upsert');
        result.current.provisionalEntries.noteClosed('proj-a', 'sess-n1');
        writePersistedChatThreadState('proj-a', { activeSessionIds: [], selectedSessionId: undefined });
      });
      await act(async () => { list.resolve(SERVER_LIST); await list.promise; });
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-a', 'sess-b', 'sess-c'] });
      expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toEqual(['sess-a', 'sess-b', 'sess-c']);
    });

    it('keeps a thread the user closed and then reopened during the first list: noteReopened takes it off the closed ids (R1)', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      act(() => {
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
        result.current.threadListOrder.noteEntryWrite('proj-a', thread('sess-n1'), 'upsert');
        result.current.threadListOrder.noteEntryWrite('proj-a', thread('sess-n2'), 'upsert');
        result.current.provisionalEntries.noteClosed('proj-a', 'sess-n1');
        result.current.provisionalEntries.noteReopened('proj-a', 'sess-n1');
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-n2', 'sess-n1'], selectedSessionId: 'sess-n1' });
      });
      await act(async () => { list.resolve(SERVER_LIST); await list.promise; });
      expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-n1', 'sess-n2']);
      expect(result.current.key.selectedThreadIds).toEqual({ 'proj-a': 'sess-n1' });
    });

    it('leaves a closed thread out of the widen on the adopted-open path as well', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      act(() => {
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
        result.current.restoredProjectsRef.current.add('proj-a');
        result.current.openThreadIdsRef.current = { 'proj-a': ['sess-new'] };
        result.current.provisionalEntries.noteClosed('proj-a', 'sess-b');
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
      });
      await act(async () => { list.resolve(SERVER_LIST); await list.promise; });
      expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toEqual(['sess-a', 'sess-c', 'sess-new']);
      expect(result.current.provisionalEntries.closedIds('proj-a').size).toBe(0);
    });

    it('keeps a thread closed after a failed fetch when the next visit reaches the server', async () => {
      // 1 回目の訪問: 送信 N1・N2 が仮のエントリを書き、一覧の fetch が失敗する。そのあとで N1 を閉じる(印は残り、閉じた id を覚える)。
      let visits = 0;
      fetchChatThreadsMock.mockImplementation(async (projectId: string) => {
        if (projectId !== 'proj-a') return [];
        visits += 1;
        if (visits === 1) throw new Error('boom');
        return [...SERVER_LIST, thread('sess-n1'), thread('sess-n2')];
      });
      const { result, rerender } = renderProbe();
      act(() => {
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-n1', 'sess-n2'], selectedSessionId: 'sess-n2' });
      });
      await flush();
      await flush();
      act(() => {
        result.current.provisionalEntries.noteClosed('proj-a', 'sess-n1');
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-n2'], selectedSessionId: 'sess-n2' });
      });
      rerender({ projectId: 'proj-b' });
      await flush();
      rerender({ projectId: 'proj-a' });
      await flush();
      await flush();
      expect(result.current.openThreadIds['proj-a']).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-n2']);
    });

    it('lowers the mark once the response has been restored from, and does not widen a later visit', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      act(() => {
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
      });
      await act(async () => { list.resolve([...SERVER_LIST, thread('sess-new')]); await list.promise; });
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-a', 'sess-b', 'sess-c', 'sess-new'] });
      expect(result.current.provisionalEntries.isProvisional('proj-a', readPersistedChatThreads()['proj-a'])).toBe(false);
    });

    it('lowers the mark on the adopted-open path too, once the server list is added', async () => {
      const list = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValue(list.promise);
      const { result } = renderProbe();
      act(() => {
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
        result.current.restoredProjectsRef.current.add('proj-a');
        result.current.openThreadIdsRef.current = { 'proj-a': ['sess-new'] };
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
      });
      await act(async () => { list.resolve(SERVER_LIST); await list.promise; });
      expect(result.current.provisionalEntries.isProvisional('proj-a', readPersistedChatThreads()['proj-a'])).toBe(false);
    });

    it('keeps the mark when the fetch fails, and the next visit that reaches the server opens the server list', async () => {
      // 1 回目の訪問: 送信が最初のエントリを書き(マーカーあり)、一覧の fetch が失敗する。open は永続化のまま、マーカーは残る。
      // (取り消し・失敗で着地しなかった仮のエントリを、次の訪問で再訪の記録と取り違えない。)
      let visits = 0;
      fetchChatThreadsMock.mockImplementation(async (projectId: string) => {
        if (projectId !== 'proj-a') return [];
        visits += 1;
        if (visits === 1) throw new Error('boom');
        return [...SERVER_LIST, thread('sess-new')];
      });
      const { result, rerender } = renderProbe();
      act(() => {
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
      });
      await flush();
      await flush();
      expect(result.current.openThreadIds).toEqual({ 'proj-a': ['sess-new'] });
      expect(result.current.provisionalEntries.isProvisional('proj-a', readPersistedChatThreads()['proj-a'])).toBe(true);

      rerender({ projectId: 'proj-b' });
      await flush();
      rerender({ projectId: 'proj-a' });
      await flush();
      await flush();
      expect(result.current.openThreadIds['proj-a']).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-new']);
      expect(result.current.provisionalEntries.isProvisional('proj-a', readPersistedChatThreads()['proj-a'])).toBe(false);
    });

    it('keeps the mark when the cycle is cancelled by a project switch before the response', async () => {
      const first = deferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockReturnValueOnce(first.promise).mockResolvedValue([...SERVER_LIST, thread('sess-new')]);
      const { result, rerender } = renderProbe();
      act(() => {
        result.current.provisionalEntries.markIfFirstEntry('proj-a');
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
      });
      rerender({ projectId: 'proj-b' });
      await flush();
      await act(async () => { first.resolve([]); await first.promise; });
      expect(result.current.provisionalEntries.isProvisional('proj-a', readPersistedChatThreads()['proj-a'])).toBe(true);

      rerender({ projectId: 'proj-a' });
      await flush();
      await flush();
      expect(result.current.openThreadIds['proj-a']).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-new']);
    });

    describe('the mark is stored, so it survives a reload or closing the chat panel (bdboard-521p)', () => {
      it('widens with the server list on a fresh mount when the first list never landed: the stored [N] is not a revisit record', async () => {
        // 1 回目のマウント: 初回の一覧が着地しない(リロード・パネルを閉じる)まま、送信が最初のエントリを書く。
        fetchChatThreadsMock.mockReturnValue(new Promise<ChatThreadDto[]>(() => undefined));
        const first = renderProbe();
        act(() => {
          first.result.current.provisionalEntries.markIfFirstEntry('proj-a');
          writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
        });
        first.unmount();
        expect(readPersistedChatThreads()['proj-a']).toEqual({
          activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new', provisional: true,
        });

        // 2 回目のマウント(メモリの印は無い。読めるのは保存だけ): 一覧が着地すると、サーバー一覧と [N] の和で開く。
        fetchChatThreadsMock.mockResolvedValue([...SERVER_LIST, thread('sess-new')]);
        const second = renderProbe();
        await flush();
        await flush();
        expect(second.result.current.openThreadIds['proj-a']).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-new']);
        expect(second.result.current.key.selectedThreadIds['proj-a']).toBe('sess-new');
        // 復元(E7)で保存の印も下りる: 以後の訪問で広げ直さない。
        expect(readPersistedChatThreads()['proj-a']).toEqual({
          activeSessionIds: ['sess-a', 'sess-b', 'sess-c', 'sess-new'], selectedSessionId: 'sess-new',
        });
      });

      it('leaves a thread closed during the earlier mount out of the widen after a fresh mount (the closed ids are stored)', async () => {
        fetchChatThreadsMock.mockReturnValue(new Promise<ChatThreadDto[]>(() => undefined));
        const first = renderProbe();
        act(() => {
          first.result.current.provisionalEntries.markIfFirstEntry('proj-a');
          writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-n1', 'sess-n2'], selectedSessionId: 'sess-n2' });
          first.result.current.provisionalEntries.noteClosed('proj-a', 'sess-n1');
          writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-n2'], selectedSessionId: 'sess-n2' });
        });
        first.unmount();

        fetchChatThreadsMock.mockResolvedValue([...SERVER_LIST, thread('sess-n1'), thread('sess-n2')]);
        const second = renderProbe();
        await flush();
        await flush();
        expect(second.result.current.openThreadIds['proj-a']).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-n2']);
        expect(readPersistedChatThreads()['proj-a']).toEqual({
          activeSessionIds: ['sess-a', 'sess-b', 'sess-c', 'sess-n2'], selectedSessionId: 'sess-n2',
        });
      });

      it('keeps the stored mark when the fresh mount\'s fetch fails too, and a later visit that reaches the server widens', async () => {
        fetchChatThreadsMock.mockReturnValue(new Promise<ChatThreadDto[]>(() => undefined));
        const first = renderProbe();
        act(() => {
          first.result.current.provisionalEntries.markIfFirstEntry('proj-a');
          writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
        });
        first.unmount();

        fetchChatThreadsMock.mockRejectedValue(new Error('down'));
        const second = renderProbe();
        await flush();
        await flush();
        expect(second.result.current.openThreadIds['proj-a']).toEqual(['sess-new']);
        expect(readPersistedChatThreads()['proj-a']?.provisional).toBe(true);
        second.unmount();

        fetchChatThreadsMock.mockResolvedValue([...SERVER_LIST, thread('sess-new')]);
        const third = renderProbe();
        await flush();
        await flush();
        expect(third.result.current.openThreadIds['proj-a']).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-new']);
        expect(readPersistedChatThreads()['proj-a']).not.toHaveProperty('provisional');
      });

      it('treats an old-format stored entry as the user record on a fresh mount: no widening', async () => {
        // bdboard-521p 以前に書かれた形のリテラル(印のフィールドが無い)。
        localStorage.setItem(
          'bdboard.chat.thread.v2',
          '{"proj-a":{"activeSessionIds":["sess-a"],"selectedSessionId":"sess-a"}}',
        );
        fetchChatThreadsMock.mockResolvedValue(SERVER_LIST);
        const { result } = renderProbe();
        await flush();
        await flush();
        expect(result.current.openThreadIds['proj-a']).toEqual(['sess-a']);
        expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: ['sess-a'], selectedSessionId: 'sess-a' });
      });

      it('lowers the stored mark on the adopted-open path as well', async () => {
        const list = deferred<ChatThreadDto[]>();
        fetchChatThreadsMock.mockReturnValue(list.promise);
        const { result } = renderProbe();
        act(() => {
          result.current.provisionalEntries.markIfFirstEntry('proj-a');
          result.current.restoredProjectsRef.current.add('proj-a');
          result.current.openThreadIdsRef.current = { 'proj-a': ['sess-new'] };
          writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
        });
        expect(readPersistedChatThreads()['proj-a']?.provisional).toBe(true);
        await act(async () => { list.resolve(SERVER_LIST); await list.promise; });
        expect(readPersistedChatThreads()['proj-a']).not.toHaveProperty('provisional');
      });
    });

    describe('a first entry written after the first list failed is provisional (bdboard-521p, E7 failure path)', () => {
      it('marks the first entry a send writes after the fetch failed, so the next visit widens', async () => {
        let visits = 0;
        fetchChatThreadsMock.mockImplementation(async (projectId: string) => {
          if (projectId !== 'proj-a') return [];
          visits += 1;
          if (visits === 1) throw new Error('boom');
          return [...SERVER_LIST, thread('sess-new')];
        });
        const { result, rerender } = renderProbe();
        await flush();
        await flush();
        // 失敗した E7 は「復元済み」を立てるが、永続化エントリは無いまま(open は空)。
        expect(result.current.restoredProjectsRef.current.has('proj-a')).toBe(true);
        expect(readPersistedChatThreads()['proj-a']).toBeUndefined();

        // そのあとの送信が最初の永続化エントリを書く(commitSuccess と同じ順: 印 → 書き込み)。
        act(() => {
          result.current.provisionalEntries.markIfFirstEntry('proj-a');
          writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
        });
        expect(readPersistedChatThreads()['proj-a']).toEqual({
          activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new', provisional: true,
        });
        expect(result.current.provisionalEntries.isProvisional('proj-a', readPersistedChatThreads()['proj-a'])).toBe(true);

        rerender({ projectId: 'proj-b' });
        await flush();
        rerender({ projectId: 'proj-a' });
        await flush();
        await flush();
        expect(result.current.openThreadIds['proj-a']).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-new']);
        expect(readPersistedChatThreads()['proj-a']).not.toHaveProperty('provisional');
      });

      it('does not mark a send after an agent change that followed the failed fetch: the explicit empty is the record', async () => {
        fetchChatThreadsMock.mockRejectedValue(new Error('boom'));
        const { result } = renderProbe();
        await flush();
        await flush();
        // エージェント切替(handleAgentChange)の順: 空を書き、復元済みを立て、settle で印を下ろす。
        act(() => {
          writePersistedChatThreadState('proj-a', { activeSessionIds: [], selectedSessionId: undefined });
          result.current.restoredProjectsRef.current.add('proj-a');
          result.current.provisionalEntries.settle('proj-a');
          result.current.provisionalEntries.markIfFirstEntry('proj-a');
          writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
        });
        expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
      });

      it('does not mark when the failed fetch left an existing entry: it is still the user record', async () => {
        writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
        fetchChatThreadsMock.mockRejectedValue(new Error('boom'));
        const { result } = renderProbe();
        await flush();
        await flush();
        act(() => {
          result.current.provisionalEntries.markIfFirstEntry('proj-a');
          writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-1', 'sess-new'], selectedSessionId: 'sess-new' });
        });
        expect(readPersistedChatThreads()['proj-a']).toEqual({
          activeSessionIds: ['sess-1', 'sess-new'], selectedSessionId: 'sess-new',
        });
      });
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
