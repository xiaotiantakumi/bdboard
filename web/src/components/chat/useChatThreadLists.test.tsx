import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../../chatThreadStorage';
import { useChatThreadLists, type UseChatThreadListsDrawerActions } from './useChatThreadLists';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    deleteChatThread: vi.fn(() => Promise.resolve()),
    updateChatThread: vi.fn(() =>
      Promise.resolve({
        sessionId: 'sess-1',
        agentId: 'agent-a',
        title: 'updated',
        pinned: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      } satisfies ChatThreadDto),
    ),
  };
});

import { deleteChatThread, updateChatThread } from '../../api';

const deleteChatThreadMock = vi.mocked(deleteChatThread);
const updateChatThreadMock = vi.mocked(updateChatThread);

function thread(overrides: Partial<ChatThreadDto>): ChatThreadDto {
  return {
    sessionId: 'sess-1',
    agentId: 'agent-a',
    title: null,
    pinned: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDrawer(): UseChatThreadListsDrawerActions {
  return {
    selectThread: vi.fn(),
    cancelInteractionsForSession: vi.fn(),
    cancelConfirmDelete: vi.fn(),
    cancelRename: vi.fn(),
    closeDrawer: vi.fn(),
  };
}

describe('useChatThreadLists', () => {
  beforeEach(() => {
    localStorage.clear();
    deleteChatThreadMock.mockClear();
    updateChatThreadMock.mockClear();
    deleteChatThreadMock.mockResolvedValue();
  });

  function setup(overrides: Partial<Parameters<typeof useChatThreadLists>[0]> = {}) {
    const setSelectedThreadIds = vi.fn();
    const setThreadError = vi.fn();
    const drawer = makeDrawer();
    const params = {
      selectedProjectId: 'project-a',
      currentSessionId: undefined as string | undefined,
      setSelectedThreadIds,
      selectedThreadIdsRef: { current: {} as Record<string, string | undefined> },
      setThreadError,
      renameDraft: '',
      drawer,
      ...overrides,
    };
    const { result, rerender } = renderHook((props) => useChatThreadLists(props), {
      initialProps: params,
    });
    return { result, rerender, setSelectedThreadIds, setThreadError, drawer, params };
  }

  it('closeThread falls back to the newest-first displayed thread, not insertion order (bdboard-3tw.157)', () => {
    // Insertion order: sess-old, sess-mid, sess-new. Newest-first display order is the
    // reverse. Closing the currently-selected oldest thread must select the newest
    // remaining thread (sess-new), not next[0] (sess-mid) from insertion order.
    const { result, rerender, setSelectedThreadIds, params } = setup({
      currentSessionId: 'sess-old',
      selectedThreadIdsRef: { current: { 'project-a': 'sess-old' } },
    });
    act(() => {
      result.current.setOpenThreadIds((prev) => ({
        ...prev,
        'project-a': ['sess-old', 'sess-mid', 'sess-new'],
      }));
      result.current.setThreadLists((prev) => ({
        ...prev,
        'project-a': [
          thread({ sessionId: 'sess-old', updatedAt: '2026-01-01T00:00:00.000Z' }),
          thread({ sessionId: 'sess-mid', updatedAt: '2026-01-02T00:00:00.000Z' }),
          thread({ sessionId: 'sess-new', updatedAt: '2026-01-03T00:00:00.000Z' }),
        ],
      }));
    });
    rerender({ ...params, currentSessionId: 'sess-old' });
    act(() => result.current.closeThread('sess-old'));
    expect(setSelectedThreadIds).toHaveBeenCalled();
    const updater = setSelectedThreadIds.mock.calls.at(-1)![0] as (
      prev: Record<string, string | undefined>,
    ) => Record<string, string | undefined>;
    expect(updater({})).toEqual({ 'project-a': 'sess-new' });
    const persisted = readPersistedChatThreads();
    expect(persisted['project-a']?.selectedSessionId).toBe('sess-new');
    expect(persisted['project-a']?.activeSessionIds).toEqual(['sess-mid', 'sess-new']);
  });

  it('closeThread does not reassign selection when the closed thread was not selected', () => {
    const { result, setSelectedThreadIds } = setup({ currentSessionId: 'sess-mid' });
    act(() => {
      result.current.setOpenThreadIds((prev) => ({
        ...prev,
        'project-a': ['sess-old', 'sess-mid'],
      }));
    });
    act(() => result.current.closeThread('sess-old'));
    expect(setSelectedThreadIds).not.toHaveBeenCalled();
  });

  it('closeThread clears drawer interactions for the closed session', () => {
    const { result, drawer } = setup();
    act(() => result.current.closeThread('sess-old'));
    expect(drawer.cancelInteractionsForSession).toHaveBeenCalledWith('sess-old');
  });

  it('selectOpenThread updates selection, persists, and notifies the drawer', () => {
    const { result, setSelectedThreadIds, drawer } = setup();
    act(() => {
      result.current.setOpenThreadIds((prev) => ({ ...prev, 'project-a': ['sess-1'] }));
    });
    act(() => result.current.selectOpenThread('sess-1'));
    expect(drawer.selectThread).toHaveBeenCalledOnce();
    expect(setSelectedThreadIds).toHaveBeenCalled();
    const updater = setSelectedThreadIds.mock.calls.at(-1)![0] as (
      prev: Record<string, string | undefined>,
    ) => Record<string, string | undefined>;
    expect(updater({})).toEqual({ 'project-a': 'sess-1' });
    expect(readPersistedChatThreads()['project-a']?.selectedSessionId).toBe('sess-1');
  });

  it('reopenClosedThread adds the thread back, selects it, persists, and closes the drawer', () => {
    const { result, setSelectedThreadIds, drawer } = setup();
    act(() => result.current.reopenClosedThread('sess-closed'));
    expect(result.current.openThreadIds['project-a']).toEqual(['sess-closed']);
    expect(setSelectedThreadIds).toHaveBeenCalled();
    const updater = setSelectedThreadIds.mock.calls.at(-1)![0] as (
      prev: Record<string, string | undefined>,
    ) => Record<string, string | undefined>;
    expect(updater({})).toEqual({ 'project-a': 'sess-closed' });
    expect(readPersistedChatThreads()['project-a']?.selectedSessionId).toBe('sess-closed');
    expect(drawer.closeDrawer).toHaveBeenCalledOnce();
  });

  it('closeThread keeps the provisional-entry mark and remembers the closed id, for the selected project only (bdboard-rt6i)', () => {
    const { result } = setup();
    result.current.provisionalEntries.markIfFirstEntry('project-a');
    result.current.provisionalEntries.markIfFirstEntry('project-b');
    act(() => {
      result.current.setOpenThreadIds((prev) => ({ ...prev, 'project-a': ['sess-1', 'sess-2'] }));
    });
    act(() => result.current.closeThread('sess-1'));
    // 閉じても印は下ろさない(下ろすと [sess-2] が利用者の記録になり、サーバーの他のスレッドが開かれない)。
    expect(result.current.provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(true);
    expect(Array.from(result.current.provisionalEntries.closedIds('project-a'))).toEqual(['sess-1']);
    expect(result.current.provisionalEntries.closedIds('project-b').size).toBe(0);
  });

  it('closeThread records nothing when no provisional entry is marked: the close is simply the user\'s record (bdboard-rt6i)', () => {
    const { result } = setup();
    act(() => {
      result.current.setOpenThreadIds((prev) => ({ ...prev, 'project-a': ['sess-1', 'sess-2'] }));
    });
    act(() => result.current.closeThread('sess-1'));
    expect(result.current.provisionalEntries.closedIds('project-a').size).toBe(0);
    expect(result.current.provisionalEntries.isProvisional('project-a', readPersistedChatThreads()['project-a'])).toBe(false);
  });

  it('deleteThread remembers the closed id once the delete succeeds, and not when the delete fails (bdboard-rt6i)', async () => {
    deleteChatThreadMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = setup();
    result.current.provisionalEntries.markIfFirstEntry('project-a');
    await act(async () => result.current.deleteThread('sess-1'));
    // 失敗では何も変わらない(閉じていない)。
    expect(result.current.provisionalEntries.closedIds('project-a').size).toBe(0);
    await act(async () => result.current.deleteThread('sess-1'));
    expect(Array.from(result.current.provisionalEntries.closedIds('project-a'))).toEqual(['sess-1']);
  });

  /** 印だけを見る(永続化の中身ではなく): 空でないエントリが書かれたとして、仮のエントリと読まれるか。 */
  const marked = (result: { current: { provisionalEntries: { isProvisional: (id: string, p: { activeSessionIds: string[] }) => boolean } } }) =>
    result.current.provisionalEntries.isProvisional('project-a', { activeSessionIds: ['sess-1'] });

  it('selectOpenThread marks the first entry it writes for an unrestored project (bdboard-rt6i)', () => {
    const { result } = setup();
    act(() => result.current.selectOpenThread('sess-1'));
    expect(marked(result)).toBe(true);
  });

  it('reopenClosedThread marks the first entry it writes for an unrestored project (bdboard-rt6i)', () => {
    const { result } = setup();
    act(() => result.current.reopenClosedThread('sess-closed'));
    expect(marked(result)).toBe(true);
  });

  it('reopenClosedThread takes the reopened id off the closed ids, so a list that lands later does not subtract it (bdboard-rt6i)', () => {
    const { result } = setup();
    result.current.provisionalEntries.markIfFirstEntry('project-a');
    result.current.provisionalEntries.noteClosed('project-a', 'sess-closed');
    result.current.provisionalEntries.noteClosed('project-a', 'sess-other');
    act(() => result.current.reopenClosedThread('sess-closed'));
    expect(Array.from(result.current.provisionalEntries.closedIds('project-a'))).toEqual(['sess-other']);
  });

  it('does not mark a project that already has an entry, or is already restored (bdboard-rt6i)', () => {
    writePersistedChatThreadState('project-a', { activeSessionIds: ['sess-x'], selectedSessionId: 'sess-x' });
    const withEntry = setup();
    act(() => withEntry.result.current.selectOpenThread('sess-1'));
    expect(marked(withEntry.result)).toBe(false);

    localStorage.clear();
    const restored = setup();
    restored.result.current.restoredProjectsRef.current.add('project-a');
    act(() => restored.result.current.reopenClosedThread('sess-closed'));
    expect(marked(restored.result)).toBe(false);
  });
  it('deleteThread removes the thread on success and always cancels confirm-delete', async () => {
    const { result, setThreadError, drawer } = setup({ currentSessionId: 'sess-1' });
    act(() => {
      result.current.setOpenThreadIds((prev) => ({ ...prev, 'project-a': ['sess-1'] }));
      result.current.setThreadLists((prev) => ({
        ...prev,
        'project-a': [thread({ sessionId: 'sess-1' })],
      }));
    });
    await act(async () => result.current.deleteThread('sess-1'));
    expect(deleteChatThreadMock).toHaveBeenCalledWith('sess-1', 'project-a');
    expect(result.current.threadLists['project-a']).toEqual([]);
    expect(setThreadError).toHaveBeenCalledWith(null);
    expect(drawer.cancelConfirmDelete).toHaveBeenCalledOnce();
  });

  it('deleteThread reports an error and still cancels confirm-delete on failure', async () => {
    deleteChatThreadMock.mockRejectedValueOnce(new Error('boom'));
    const { result, setThreadError, drawer } = setup();
    await act(async () => result.current.deleteThread('sess-1'));
    expect(setThreadError).toHaveBeenCalledWith('スレッドの削除に失敗しました。');
    expect(drawer.cancelConfirmDelete).toHaveBeenCalledOnce();
  });

  it('renameThread sends title: null for an empty draft and cancels rename in finally', async () => {
    const { result, setThreadError, drawer } = setup({ renameDraft: '   ' });
    act(() => {
      result.current.setThreadLists((prev) => ({
        ...prev,
        'project-a': [thread({ sessionId: 'sess-1', title: 'old title' })],
      }));
    });
    await act(async () => result.current.renameThread('sess-1'));
    expect(updateChatThreadMock).toHaveBeenCalledWith('sess-1', 'project-a', { title: null });
    expect(setThreadError).toHaveBeenCalledWith(null);
    expect(drawer.cancelRename).toHaveBeenCalledOnce();
  });

  it('renameThread sends the trimmed title for a nonempty draft', async () => {
    const { result } = setup({ renameDraft: '  renamed  ' });
    await act(async () => result.current.renameThread('sess-1'));
    expect(updateChatThreadMock).toHaveBeenCalledWith('sess-1', 'project-a', {
      title: 'renamed',
    });
  });

  it('renameThread reports an error and still cancels rename on failure', async () => {
    updateChatThreadMock.mockRejectedValueOnce(new Error('boom'));
    const { result, setThreadError, drawer } = setup({ renameDraft: 'x' });
    await act(async () => result.current.renameThread('sess-1'));
    expect(setThreadError).toHaveBeenCalledWith('スレッド名の変更に失敗しました。');
    expect(drawer.cancelRename).toHaveBeenCalledOnce();
  });

  it('togglePin sends the inverted pinned value and updates the thread list on success', async () => {
    const { result, setThreadError } = setup();
    act(() => {
      result.current.setThreadLists((prev) => ({
        ...prev,
        'project-a': [thread({ sessionId: 'sess-1', pinned: false })],
      }));
    });
    await act(async () => result.current.togglePin('sess-1', false));
    expect(updateChatThreadMock).toHaveBeenCalledWith('sess-1', 'project-a', { pinned: true });
    expect(setThreadError).toHaveBeenCalledWith(null);
  });

  it('togglePin reports an error on failure', async () => {
    updateChatThreadMock.mockRejectedValueOnce(new Error('boom'));
    const { result, setThreadError } = setup();
    await act(async () => result.current.togglePin('sess-1', true));
    expect(setThreadError).toHaveBeenCalledWith('ピン留めの変更に失敗しました。');
  });

  describe('thread-list fetch order (bdboard-z9mn)', () => {
    it('renameThread lays the renamed entry over a list that started before the rename', async () => {
      updateChatThreadMock.mockResolvedValueOnce(thread({ sessionId: 'sess-1', title: 'renamed' }));
      const { result } = setup({ renameDraft: 'renamed' });
      const seq = result.current.threadListOrder.begin('project-a');
      await act(async () => result.current.renameThread('sess-1'));
      expect(result.current.threadListOrder.admit('project-a', seq, [thread({ sessionId: 'sess-1', title: 'old title' })])).toEqual([
        thread({ sessionId: 'sess-1', title: 'renamed' }),
      ]);
    });

    it('togglePin lays the pinned entry over a list that started before the toggle', async () => {
      updateChatThreadMock.mockResolvedValueOnce(thread({ sessionId: 'sess-1', pinned: true }));
      const { result } = setup();
      const seq = result.current.threadListOrder.begin('project-a');
      await act(async () => result.current.togglePin('sess-1', false));
      expect(result.current.threadListOrder.admit('project-a', seq, [thread({ sessionId: 'sess-1', pinned: false })])).toEqual([
        thread({ sessionId: 'sess-1', pinned: true }),
      ]);
    });

    it('does not record a failed rename', async () => {
      updateChatThreadMock.mockRejectedValueOnce(new Error('boom'));
      const { result } = setup({ renameDraft: 'x' });
      const seq = result.current.threadListOrder.begin('project-a');
      await act(async () => result.current.renameThread('sess-1'));
      expect(result.current.threadListOrder.admit('project-a', seq, [thread({ sessionId: 'sess-1', title: 'old title' })])).toEqual([
        thread({ sessionId: 'sess-1', title: 'old title' }),
      ]);
    });

    it('deleteThread forgets the local write so a later list does not bring the thread back', async () => {
      const { result } = setup();
      const order = result.current.threadListOrder;
      const seq = order.begin('project-a');
      order.noteEntryWrite('project-a', thread({ sessionId: 'sess-1', title: 'sent' }), 'upsert');
      await act(async () => result.current.deleteThread('sess-1'));
      expect(order.admit('project-a', seq, [])).toEqual([]);
    });

    // bdboard-gtv0: 削除前に始まった一覧取得(E7・採用の取り直し・回収の hydrate は、どれも begin → fetch → admit)の
    // 応答が削除の後に届いても、削除したスレッドを一覧に戻さない。
    it('deleteThread keeps a list that started before the delete from bringing the thread back (bdboard-gtv0)', async () => {
      const { result } = setup();
      const order = result.current.threadListOrder;
      const seq = order.begin('project-a');
      act(() => {
        result.current.setThreadLists((prev) => ({
          ...prev,
          'project-a': [thread({ sessionId: 'sess-1' }), thread({ sessionId: 'sess-2' })],
        }));
      });
      await act(async () => result.current.deleteThread('sess-1'));
      expect(result.current.threadLists['project-a']).toEqual([thread({ sessionId: 'sess-2' })]);
      // 削除の前にサーバーが組み立てた一覧(sess-1 入り)が遅れて届く。
      const admitted = order.admit('project-a', seq, [thread({ sessionId: 'sess-1' }), thread({ sessionId: 'sess-2' })]);
      expect(admitted).toEqual([thread({ sessionId: 'sess-2' })]);
      expect(order.appliedList('project-a')).toEqual([thread({ sessionId: 'sess-2' })]);
    });

    it('deleteThread keeps the thread out of every list that started before the delete', async () => {
      const { result } = setup();
      const order = result.current.threadListOrder;
      // 初回の一覧(E7)と採用の取り直しが、どちらも削除の前に始まっている。
      const e7Seq = order.begin('project-a');
      const adoptionSeq = order.begin('project-a');
      await act(async () => result.current.deleteThread('sess-1'));
      expect(order.admit('project-a', e7Seq, [thread({ sessionId: 'sess-1' })])).toEqual([]);
      expect(order.admit('project-a', adoptionSeq, [thread({ sessionId: 'sess-1' }), thread({ sessionId: 'sess-2' })])).toEqual([
        thread({ sessionId: 'sess-2' }),
      ]);
    });

    it('deleteThread trusts a list that started after the delete', async () => {
      const { result } = setup();
      const order = result.current.threadListOrder;
      order.begin('project-a');
      await act(async () => result.current.deleteThread('sess-1'));
      const later = order.begin('project-a');
      expect(order.admit('project-a', later, [thread({ sessionId: 'sess-1' })])).toEqual([thread({ sessionId: 'sess-1' })]);
    });

    it('deleteThread does not record a delete that failed on the server', async () => {
      deleteChatThreadMock.mockRejectedValueOnce(new Error('boom'));
      const { result } = setup();
      const order = result.current.threadListOrder;
      const seq = order.begin('project-a');
      await act(async () => result.current.deleteThread('sess-1'));
      expect(order.admit('project-a', seq, [thread({ sessionId: 'sess-1' })])).toEqual([thread({ sessionId: 'sess-1' })]);
    });

    it('deleteThread also removes a thread whose rename response landed after the delete (bdboard-gtv0)', async () => {
      updateChatThreadMock.mockResolvedValueOnce(thread({ sessionId: 'sess-1', title: 'renamed' }));
      const { result } = setup({ renameDraft: 'renamed' });
      const order = result.current.threadListOrder;
      const seq = order.begin('project-a');
      await act(async () => result.current.deleteThread('sess-1'));
      // 削除より前に送ったリネームの応答が、削除の後に届いて replace の書き込みを記録した。
      await act(async () => result.current.renameThread('sess-1'));
      expect(order.admit('project-a', seq, [thread({ sessionId: 'sess-1', title: 'old title' })])).toEqual([]);
    });

    it('keeps the order object stable across renders', () => {
      const { result, rerender, params } = setup();
      const before = result.current.threadListOrder;
      rerender({ ...params, renameDraft: 'changed' });
      expect(result.current.threadListOrder).toBe(before);
    });
  });

  it('derives displayedOpenThreads newest-first while leaving openThreadIds insertion order intact', async () => {
    const { result } = setup();
    act(() => {
      result.current.setOpenThreadIds((prev) => ({
        ...prev,
        'project-a': ['sess-old', 'sess-new'],
      }));
      result.current.setThreadLists((prev) => ({
        ...prev,
        'project-a': [
          thread({ sessionId: 'sess-old', updatedAt: '2026-01-01T00:00:00.000Z' }),
          thread({ sessionId: 'sess-new', updatedAt: '2026-01-03T00:00:00.000Z' }),
        ],
      }));
    });
    await waitFor(() => {
      expect(result.current.displayedOpenThreads).toEqual(['sess-new', 'sess-old']);
    });
    expect(result.current.openThreadIds['project-a']).toEqual(['sess-old', 'sess-new']);
    expect(result.current.openThreadIdsRef.current['project-a']).toEqual(['sess-old', 'sess-new']);
  });

  it('computes closedThreads and hasClosedThreads from threads not in openThreadIds', () => {
    const { result } = setup();
    act(() => {
      result.current.setOpenThreadIds((prev) => ({ ...prev, 'project-a': ['sess-open'] }));
      result.current.setThreadLists((prev) => ({
        ...prev,
        'project-a': [
          thread({ sessionId: 'sess-open' }),
          thread({ sessionId: 'sess-closed' }),
        ],
      }));
    });
    expect(result.current.hasClosedThreads).toBe(true);
    expect(result.current.closedThreads.map((t) => t.sessionId)).toEqual(['sess-closed']);
  });

  it('currentThreadTitle falls back to placeholders for missing title and no selection', () => {
    const { result, rerender, params } = setup();
    expect(result.current.currentThreadTitle).toBe('新規');
    act(() => {
      result.current.setThreadLists((prev) => ({
        ...prev,
        'project-a': [thread({ sessionId: 'sess-1', title: null })],
      }));
    });
    rerender({ ...params, currentSessionId: 'sess-1' });
    expect(result.current.currentThreadTitle).toBe('(無題)');
  });
});
