import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { readPersistedChatThreads } from '../../chatThreadStorage';
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
