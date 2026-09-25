import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useChatConversationsState } from './useChatConversationsState';
import { useConversationKey } from './useConversationKey';
import { useChatThreadLists } from './useChatThreadLists';
import { useChatSendState } from './useChatSendState';
import { useChatSubmit, type ChatSubmitContext } from './useChatSubmit';
import { useTurnStatusRecovery } from './useTurnStatusRecovery';

// bdboard-sso1.83 第13b段の「先に足すもの」: 送信本体(useChatSubmit)と、送信結果を
// ストアへ書く action(useChatSendCommits の commitSuccess/commitFailure/appendTranscript)
// の useCallback 依存配列に入る setter/ref が、state が動いても同じ参照のままで
// あることを固定する。ここが揺れると submit が毎レンダー作り直され、送信中の
// クロージャ(fail() が抱える commitFailure など)の捕まえ方が変わる兆候になる。
// useChatDraftState(setInput/updateConversationAttachments/setAttachmentError)と
// useChatSendState(setIsSending ほか)の setter はそれぞれのテストファイルで固定済み。

function expectSameReferences<T extends object>(before: T, after: T, keys: readonly (keyof T)[]) {
  const changed = keys.filter((key) => before[key] !== after[key]);
  expect(changed).toEqual([]);
}

describe('submit/commit deps reference stability (bdboard-sso1.83 第13b段)', () => {
  it('useChatConversationsState keeps its setters and refs stable while the stores change', () => {
    const { result } = renderHook(() => useChatConversationsState());
    const before = result.current;
    act(() => {
      result.current.setConversations((prev) => ({ ...prev, key: { messages: [] } }));
      result.current.setHistoryLoadedFor((prev) => ({ ...prev, key: true }));
      result.current.setThreadModelIds((prev) => ({ ...prev, key: 'model' }));
      result.current.setLoadingHistoryFor('key');
    });
    expect(result.current.conversations).not.toBe(before.conversations);
    expectSameReferences(before, result.current, [
      'setConversations',
      'setHistoryLoadedFor',
      'setThreadModelIds',
      'setLoadingHistoryFor',
      'conversationsRef',
      'threadModelIdsRef',
      'historyRequestIdRef',
      'threadListRequestIdRef',
    ]);
  });

  it('useConversationKey keeps setSelectedThreadIds/setDraftNonces and its refs stable across a key change', () => {
    const { result } = renderHook(() => useConversationKey('project-a'));
    const before = result.current;
    act(() => {
      result.current.setSelectedThreadIds((prev) => ({ ...prev, 'project-a': 'sess-1' }));
    });
    expect(result.current.currentConversationKey).toBe('sess-1');
    expectSameReferences(before, result.current, [
      'setSelectedThreadIds',
      'setDraftNonces',
      'selectedThreadIdsRef',
      'draftNoncesRef',
      'currentConversationKeyRef',
    ]);
  });

  it('useChatThreadLists keeps setThreadLists/setOpenThreadIds stable while the lists change', () => {
    const drawer = {
      selectThread: vi.fn(),
      cancelInteractionsForSession: vi.fn(),
      cancelConfirmDelete: vi.fn(),
      cancelRename: vi.fn(),
      closeDrawer: vi.fn(),
    };
    const { result } = renderHook(() =>
      useChatThreadLists({
        selectedProjectId: 'project-a',
        currentSessionId: undefined,
        setSelectedThreadIds: vi.fn(),
        selectedThreadIdsRef: { current: {} },
        setThreadError: vi.fn(),
        renameDraft: '',
        drawer,
      }),
    );
    const before = result.current;
    act(() => {
      result.current.setThreadLists((prev) => ({ ...prev, 'project-a': [] }));
      result.current.setOpenThreadIds((prev) => ({ ...prev, 'project-a': ['sess-1'] }));
    });
    expect(result.current.openThreadIds).not.toBe(before.openThreadIds);
    expectSameReferences(before, result.current, ['setThreadLists', 'setOpenThreadIds', 'openThreadIdsRef']);
  });

  it('useTurnStatusRecovery keeps resetBackgroundTurnStatus stable across renders (第13b段で useCallback 化)', () => {
    const { result, rerender } = renderHook(() =>
      useTurnStatusRecovery({
        // '' のとき回収 effect は何もしないので、fetch を伴わずに参照だけを見られる。
        selectedProjectId: '',
        generation: 0,
        detachedSendsRef: { current: {} },
        historyRequestIdRef: { current: 0 },
        threadListRequestIdRef: { current: 0 },
        setLoadingHistoryFor: vi.fn(),
        clearStreamingReplyForKey: vi.fn(),
        clearUnresolvedSend: vi.fn(),
        applyRecoveredTurn: vi.fn(),
      }),
    );
    const before = result.current.resetBackgroundTurnStatus;
    act(() => result.current.resetBackgroundTurnStatus());
    rerender();
    expect(result.current.resetBackgroundTurnStatus).toBe(before);
  });

  it('useChatSubmit keeps submit stable while its context and deps are unchanged, and recreates it when the key changes', () => {
    const context: ChatSubmitContext = {
      selectedProjectId: 'project-a',
      currentConversationKey: 'key-a',
      currentSessionId: undefined,
      conversations: {},
      selectedAgentId: '',
      selectedAgent: undefined,
      selectedAgentUnavailable: false,
      showModelSelect: false,
      effectiveModelId: '',
      isHistoryPending: false,
      currentInput: '',
      currentAttachments: [],
    };
    const stable = {
      draft: { setInput: vi.fn(), updateConversationAttachments: vi.fn(), setAttachmentError: vi.fn() },
      commitSuccess: vi.fn(),
      commitFailure: vi.fn(),
      appendTranscript: vi.fn(),
      resetBackgroundTurnStatus: vi.fn(),
      inputRef: { current: null },
    };
    const { result, rerender } = renderHook(
      ({ ctx }: { ctx: ChatSubmitContext }) => {
        const send = useChatSendState();
        return useChatSubmit({ ...stable, context: ctx, send });
      },
      { initialProps: { ctx: context } },
    );
    const before = result.current;
    rerender({ ctx: { ...context } });
    expect(result.current.submit).toBe(before.submit);
    expect(result.current.handleSubmit).toBe(before.handleSubmit);
    rerender({ ctx: { ...context, currentConversationKey: 'key-b' } });
    expect(result.current.submit).not.toBe(before.submit);
  });
});
