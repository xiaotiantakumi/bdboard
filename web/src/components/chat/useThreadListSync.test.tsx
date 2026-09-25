// bdboard-sso1.83 第14d段: useThreadListSync(スレッド一覧 effect = 設計書 §1c の E7)の
// Probe テスト。本物の useConversationKey / useChatConversationsState /
// useChatNotifications と組み合わせ、pending の無効化と消化、
// isExplicitDraftStillSelected、永続化済み選択の復元、失敗時の経路、request-id と
// cancelled のガード、依存配列を広げても再取得の契機が変わらないことを確かめる。
import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { writePersistedChatThreadState } from '../../chatThreadStorage';
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
  const pendingPrefillRef = useRef<PendingPrefill>(null);
  const pendingTicketDraftProjectRef = useRef<string | null>(null);
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
    setSelectedThreadIds: key.setSelectedThreadIds,
    startNewDraftThread,
  });
  return { key, conv, notifications, threadLists, openThreadIds, pendingPrefillRef, pendingTicketDraftProjectRef };
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
