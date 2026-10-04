import { act, renderHook } from '@testing-library/react';
import type { SetStateAction } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageResponseDto, ChatThreadDto } from '../../api';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../../chatThreadStorage';

// bdboard-sso1.83 第13b段: chat/useChatSendCommits.ts の store 側 action
// (commitSuccess = 旧 applyChatSuccess、commitFailure = 旧 applyChatError、
// appendTranscript = 旧 submitChatMessage の2箇所の setConversations)を直接固定する。
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, acknowledgeChatTurn: vi.fn(() => Promise.resolve()) };
});

import { acknowledgeChatTurn, ApiError } from '../../api';
import type { ChatAttachment } from './attachments';
import { createReplacedThreadMarks } from './replacedThread';
import { createThreadListFetchOrder } from './threadListFetchOrder';
import type { ChatConversationEntry } from './useChatConversationsState';
import { useChatSendCommits, type UseChatSendCommitsParams } from './useChatSendCommits';

const ackMock = vi.mocked(acknowledgeChatTurn);
const RESULT: ChatMessageResponseDto = { reply: 'AI reply', sessionId: 'sess-new', agentId: 'claude' };
const IMAGE: ChatAttachment = {
  id: 'att-1', file: new File(['x'], 'a.png', { type: 'image/png' }), mimeType: 'image/png',
  previewUrl: 'data:image/png;base64,QUJD', name: 'a.png', size: 3,
};

interface Store {
  conversations: Record<string, ChatConversationEntry>;
  historyLoadedFor: Record<string, true>;
  threadModelIds: Record<string, string>;
  threadLists: Record<string, ChatThreadDto[]>;
  openThreadIds: Record<string, string[]>;
  selectedThreadIds: Record<string, string | undefined>;
  inputs: Record<string, string>;
  attachments: Record<string, ChatAttachment[]>;
}

// useState の setter と同じ形(値か updater)を受け取り、store の該当キーへ反映する。
function setterFor<K extends keyof Store>(store: Store, key: K) {
  return vi.fn((next: SetStateAction<Store[K]>) => {
    store[key] = typeof next === 'function' ? next(store[key]) : next;
  });
}

// bdboard-33jm: 本番の useLiveMirroredState は setState と ref.current の更新を
// 同じ set 関数の中で同期させる(呼び出し元での手書き同期を廃止した)。この probe も
// 同じ契約を再現し、setter を呼ぶたびに ref.current を書き換える。
function setterForWithRef<K extends keyof Store>(
  store: Store,
  key: K,
  ref: { current: Store[K] },
) {
  return vi.fn((next: SetStateAction<Store[K]>) => {
    const value = typeof next === 'function' ? next(store[key]) : next;
    store[key] = value;
    ref.current = value;
  });
}

function setup(overrides: Partial<UseChatSendCommitsParams> = {}) {
  const store: Store = {
    conversations: {},
    historyLoadedFor: {},
    threadModelIds: {},
    threadLists: {},
    openThreadIds: {},
    selectedThreadIds: {},
    inputs: {},
    attachments: {},
  };
  const conversationInputsRef = { current: store.inputs };
  const conversationAttachmentsRef = { current: store.attachments };
  // bdboard-d7on: commitSuccess は openThreadIdsRef.current から次の open 配列を
  // 計算する(render-mirror の同期漏れ対策)。bdboard-33jm で本番側が
  // useLiveMirroredState に一本化されたため、この probe の setter
  // (setterForWithRef)も setState と同じ場所で ref.current を更新する。
  const openThreadIdsRef = { current: {} as Record<string, string[]> };
  // bdboard-7feq: 「このプロジェクトの open は復元済み(E7 / applyRecoveredTurn /
  // handleAgentChange のどれかが確立した)」のマーカー。本番は chat/useChatThreadLists.ts の
  // restoredProjectsRef。既定は空 = 未復元。
  const restoredProjectsRef = { current: new Set<string>() };
  // bdboard-d7on(Opus レビュー B1/M1 対応): commitSuccess は selectedThreadIdsRef も
  // 同じ場所で同期する。setterForWithRef が同期するので、初期値は空で足りる。
  const selectedThreadIdsRef = { current: {} as Record<string, string | undefined> };
  const params: UseChatSendCommitsParams = {
    selectedProjectId: 'proj-a',
    showModelSelect: false,
    effectiveModelId: '',
    setConversations: setterFor(store, 'conversations'),
    setHistoryLoadedFor: setterFor(store, 'historyLoadedFor'),
    setThreadModelIds: setterFor(store, 'threadModelIds'),
    setThreadLists: setterFor(store, 'threadLists'),
    setOpenThreadIds: setterForWithRef(store, 'openThreadIds', openThreadIdsRef),
    openThreadIdsRef,
    restoredProjectsRef,
    threadListOrder: createThreadListFetchOrder(),
    setSelectedThreadIds: setterForWithRef(store, 'selectedThreadIds', selectedThreadIdsRef),
    selectedThreadIdsRef,
    conversationInputsRef,
    conversationAttachmentsRef,
    setInput: vi.fn((key: string, value: string) => { store.inputs[key] = value; }),
    updateConversationAttachments: vi.fn(
      (updater: (prev: Record<string, ChatAttachment[]>) => Record<string, ChatAttachment[]>) => {
        store.attachments = updater(store.attachments);
      },
    ),
    replacedMarksRef: { current: createReplacedThreadMarks() },
    ...overrides,
  };
  const hook = renderHook((props: UseChatSendCommitsParams) => useChatSendCommits(props), { initialProps: params });
  return { hook, params, store };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('appendTranscript', () => {
  it('creates the conversation when it is missing, without inventing a sessionId', () => {
    const { hook, store } = setup();
    act(() => hook.result.current.appendTranscript('key-a', { role: 'error', text: 'warn', at: 1 }));
    expect(store.conversations).toEqual({ 'key-a': { messages: [{ role: 'error', text: 'warn', at: 1 }] } });
  });

  it('appends and keeps sessionId/agentId when no sessionId is given', () => {
    const { hook, store } = setup();
    store.conversations = { 'key-a': { messages: [{ role: 'user', text: 'old', at: 0 }], sessionId: 'sess-1', agentId: 'claude' } };
    act(() => hook.result.current.appendTranscript('key-a', { role: 'user', text: 'new', at: 2 }));
    expect(store.conversations['key-a']).toEqual({
      messages: [{ role: 'user', text: 'old', at: 0 }, { role: 'user', text: 'new', at: 2 }],
      sessionId: 'sess-1',
      agentId: 'claude',
    });
  });

  it('bdboard-pbf: bakes the resolved sessionId into the conversation when given', () => {
    const { hook, store } = setup();
    act(() => hook.result.current.appendTranscript('key-a', { role: 'user', text: 'hi', at: 3 }, 'sess-fallback'));
    expect(store.conversations['key-a']).toEqual({ sessionId: 'sess-fallback', messages: [{ role: 'user', text: 'hi', at: 3 }] });
  });
});

describe('commitSuccess', () => {
  it('re-keys a draft conversation to the confirmed sessionId and updates the thread stores', () => {
    const { hook, params, store } = setup();
    store.conversations = { 'new:proj-a:0': { messages: [{ role: 'user', text: 'hello', at: 1 }] } };
    act(() => hook.result.current.commitSuccess('new:proj-a:0', 'hello', RESULT));
    expect(Object.keys(store.conversations)).toEqual(['sess-new']);
    expect(store.conversations['sess-new']).toMatchObject({
      sessionId: 'sess-new',
      agentId: 'claude',
      messages: [{ role: 'user', text: 'hello', at: 1 }, { role: 'assistant', text: 'AI reply' }],
    });
    expect(store.historyLoadedFor).toEqual({ 'sess-new': true });
    expect(store.threadLists['proj-a']).toMatchObject([{ sessionId: 'sess-new', title: 'hello', pinned: false }]);
    expect(store.openThreadIds).toEqual({ 'proj-a': ['sess-new'] });
    expect(store.selectedThreadIds).toEqual({ 'proj-a': 'sess-new' });
    // bdboard-d7on(Opus レビュー B1/M1)由来の確認。bdboard-33jm 以降 ref の同期は
    // useLiveMirroredState の責務で、ここでの ref はこのテストのモック setter が
    // 書いたもの(本番コードの同期は useLiveMirroredState.test.tsx と
    // render-mirror-ref.race.test.tsx が検証する)。ここでは setter に渡した値の形だけを見る。
    expect(params.openThreadIdsRef.current).toEqual({ 'proj-a': ['sess-new'] });
    expect(params.selectedThreadIdsRef.current).toEqual({ 'proj-a': 'sess-new' });
    expect(ackMock).toHaveBeenCalledWith('proj-a', 'sess-new');
  });

  describe('bdboard-7feq: persisted open follows the live open once the project is restored', () => {
    it('first visit (no persisted entry): persists the live open plus the new session, not just the new session', () => {
      // E7 は初回訪問(エントリ無し)でサーバー一覧の全スレッドをメモリ上で開くが、
      // 永続化には何も書かない (threadViewRestore.ts)。ドラフトから送信して sess-d が確定した
      // とき、永続化を {[sess-d]} に潰すと、リロードで sess-a/b/c が黙って閉じられる。
      const { hook, params, store } = setup();
      params.restoredProjectsRef.current.add('proj-a');
      params.openThreadIdsRef.current = { 'proj-a': ['sess-a', 'sess-b', 'sess-c'] };
      store.openThreadIds = { 'proj-a': ['sess-a', 'sess-b', 'sess-c'] };
      expect(readPersistedChatThreads()['proj-a']).toBeUndefined();
      act(() =>
        hook.result.current.commitSuccess('new:proj-a:0', 'hello', { reply: 'AI reply', sessionId: 'sess-d', agentId: 'claude' }),
      );
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-c', 'sess-d'],
        selectedSessionId: 'sess-d',
      });
      // 永続化とメモリの open が一致する(2つが食い違っていたのがこのチケットの不具合)。
      expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toEqual(store.openThreadIds['proj-a']);
    });

    it('prefers the live open over a stale persisted entry once restored', () => {
      writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-a'], selectedSessionId: 'sess-a' });
      const { hook, params, store } = setup();
      params.restoredProjectsRef.current.add('proj-a');
      params.openThreadIdsRef.current = { 'proj-a': ['sess-a', 'sess-b', 'sess-c'] };
      store.openThreadIds = { 'proj-a': ['sess-a', 'sess-b', 'sess-c'] };
      act(() =>
        hook.result.current.commitSuccess('new:proj-a:0', 'hello', { reply: 'AI reply', sessionId: 'sess-d', agentId: 'claude' }),
      );
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-c', 'sess-d'],
        selectedSessionId: 'sess-d',
      });
    });

    it('persists the same order as memory when the sent session is already open (moved to the end)', () => {
      const { hook, params, store } = setup();
      params.restoredProjectsRef.current.add('proj-a');
      params.openThreadIdsRef.current = { 'proj-a': ['sess-a', 'sess-b', 'sess-c'] };
      store.openThreadIds = { 'proj-a': ['sess-a', 'sess-b', 'sess-c'] };
      act(() =>
        hook.result.current.commitSuccess('sess-a', 'hello', { reply: 'AI reply', sessionId: 'sess-a', agentId: 'claude' }),
      );
      expect(store.openThreadIds['proj-a']).toEqual(['sess-b', 'sess-c', 'sess-a']);
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-b', 'sess-c', 'sess-a'],
        selectedSessionId: 'sess-a',
      });
    });

    it('bdboard-rhl4: a restored project whose live open is empty (all closed) persists just the new session', () => {
      writePersistedChatThreadState('proj-a', { activeSessionIds: [], selectedSessionId: undefined });
      const { hook, params, store } = setup();
      params.restoredProjectsRef.current.add('proj-a');
      params.openThreadIdsRef.current = { 'proj-a': [] };
      store.openThreadIds = { 'proj-a': [] };
      act(() =>
        hook.result.current.commitSuccess('new:proj-a:0', 'hello', { reply: 'AI reply', sessionId: 'sess-d', agentId: 'claude' }),
      );
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-d'],
        selectedSessionId: 'sess-d',
      });
    });

    it('keeps the persisted-entry-based sum while the project is not yet restored (marker unset)', () => {
      // 一覧の初回 fetch が in-flight の間(restoredProjectsRef 未マーク)は、
      // openThreadIdsRef が他経路の書き込み分だけで、永続化の方がまだ正本。従来どおり
      // 永続化済みエントリに足す(live の open で置き換えない)。
      writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-a', 'sess-b'], selectedSessionId: 'sess-b' });
      const { hook, params } = setup();
      params.openThreadIdsRef.current = { 'proj-a': ['sess-x'] };
      act(() =>
        hook.result.current.commitSuccess('new:proj-a:0', 'hello', { reply: 'AI reply', sessionId: 'sess-d', agentId: 'claude' }),
      );
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-d'],
        selectedSessionId: 'sess-d',
      });
    });
  });

  describe('bdboard-drfb: a thread replaced by a new session leaves the open set, the persisted entry and the history flag', () => {
    const THREAD_A = { sessionId: 'sess-a', agentId: 'claude', title: 'thread a', pinned: false, updatedAt: '2026-01-01T00:00:00Z' };
    const THREAD_B = { sessionId: 'sess-b', agentId: 'claude', title: 'thread b', pinned: false, updatedAt: '2026-01-02T00:00:00Z' };
    const RESULT_C = { reply: 'AI reply', sessionId: 'sess-c', agentId: 'claude' };

    function setupWithOpenAB() {
      const hook = setup();
      hook.params.restoredProjectsRef.current.add('proj-a');
      hook.params.openThreadIdsRef.current = { 'proj-a': ['sess-a', 'sess-b'] };
      hook.store.openThreadIds = { 'proj-a': ['sess-a', 'sess-b'] };
      hook.store.selectedThreadIds = { 'proj-a': 'sess-b' };
      hook.store.threadLists = { 'proj-a': [THREAD_A, THREAD_B] };
      hook.store.historyLoadedFor = { 'sess-a': true, 'sess-b': true };
      hook.store.conversations = {
        'sess-b': { messages: [{ role: 'user', text: 'old', at: 1 }], sessionId: 'sess-b', agentId: 'claude' },
      };
      return hook;
    }

    it('live open [A,B] + commitSuccess(B -> C): open [A,C], persisted [A,C] selecting C, no historyLoadedFor[B]', () => {
      const { hook, store } = setupWithOpenAB();
      act(() => hook.result.current.commitSuccess('sess-b', 'hello', RESULT_C));
      expect(store.openThreadIds['proj-a']).toEqual(['sess-a', 'sess-c']);
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-c'],
        selectedSessionId: 'sess-c',
      });
      expect(store.selectedThreadIds['proj-a']).toBe('sess-c');
      expect(store.historyLoadedFor).toEqual({ 'sess-a': true, 'sess-c': true });
      expect(Object.keys(store.conversations)).toEqual(['sess-c']);
    });

    it('unknown chat session: the dead thread is also dropped from the thread list', () => {
      const { hook, store } = setupWithOpenAB();
      act(() =>
        hook.result.current.commitFailure('sess-b', 'hello', [], new ApiError(400, 'bad', { errorMessage: 'unknown chat session' }), 1),
      );
      act(() => hook.result.current.commitSuccess('sess-b', 'hello', RESULT_C));
      expect(store.threadLists['proj-a']?.map((thread) => thread.sessionId)).toEqual(['sess-a', 'sess-c']);
    });

    it('bdboard-gtv0: unknown chat session: a list fetch that started before the send does not bring the dead thread back, and keeps the new session', () => {
      const { hook, params } = setup();
      params.restoredProjectsRef.current.add('proj-a');
      params.openThreadIdsRef.current = { 'proj-a': ['sess-old'] };
      params.replacedMarksRef.current.goneKeys.add('sess-old');
      const order = params.threadListOrder;
      const seq = order.begin('proj-a');
      act(() => hook.result.current.commitSuccess('sess-old', 'hello', RESULT));
      const dead = { sessionId: 'sess-old', agentId: 'claude', title: 'old', pinned: false, updatedAt: 'x' };
      const other = { sessionId: 'sess-other', agentId: 'claude', title: 'other', pinned: false, updatedAt: 'x' };
      expect(order.admit('proj-a', seq, [dead, other])).toEqual([
        other,
        expect.objectContaining({ sessionId: 'sess-new', title: 'hello', pinned: false }),
      ]);
    });

    it('chat agent mismatch: the live thread stays in the thread list (closed) so it can be reopened', () => {
      const { hook, store } = setupWithOpenAB();
      act(() =>
        hook.result.current.commitFailure('sess-b', 'hello', [], new ApiError(400, 'bad', { errorMessage: 'chat agent mismatch' }), 1),
      );
      act(() => hook.result.current.commitSuccess('sess-b', 'hello', RESULT_C));
      expect(store.openThreadIds['proj-a']).toEqual(['sess-a', 'sess-c']);
      expect(store.threadLists['proj-a']?.map((thread) => thread.sessionId)).toEqual(['sess-a', 'sess-b', 'sess-c']);
      expect(store.historyLoadedFor['sess-b']).toBeUndefined();
    });

    it('without a preceding clearSession failure the replaced thread stays in the thread list', () => {
      const { hook, store } = setupWithOpenAB();
      act(() => hook.result.current.commitSuccess('sess-b', 'hello', RESULT_C));
      expect(store.threadLists['proj-a']?.map((thread) => thread.sessionId)).toEqual(['sess-a', 'sess-b', 'sess-c']);
    });

    it('the unknown-chat-session mark is consumed by the next commitSuccess and does not leak into a later one', () => {
      const { hook, store } = setupWithOpenAB();
      act(() =>
        hook.result.current.commitFailure('sess-b', 'hello', [], new ApiError(400, 'bad', { errorMessage: 'unknown chat session' }), 1),
      );
      // 同じ会話キーのまま (sessionId も変わらず) 成功した場合は置き換えではない。印は消費される。
      act(() =>
        hook.result.current.commitSuccess('sess-b', 'hello', { reply: 'AI reply', sessionId: 'sess-b', agentId: 'claude' }),
      );
      expect(store.threadLists['proj-a']?.map((thread) => thread.sessionId)).toEqual(['sess-a', 'sess-b']);
      // 後の置き換え(失敗の印なし)では一覧から落とさない。
      act(() => hook.result.current.commitSuccess('sess-b', 'again', RESULT_C));
      expect(store.threadLists['proj-a']?.map((thread) => thread.sessionId)).toEqual(['sess-a', 'sess-b', 'sess-c']);
    });

    it('a non-clearSession failure does not mark the thread as gone', () => {
      const { hook, store } = setupWithOpenAB();
      act(() => hook.result.current.commitFailure('sess-b', 'hello', [], new ApiError(409, 'busy'), 1));
      act(() => hook.result.current.commitSuccess('sess-b', 'hello', RESULT_C));
      expect(store.threadLists['proj-a']?.map((thread) => thread.sessionId)).toEqual(['sess-a', 'sess-b', 'sess-c']);
    });

    it('the first send from a draft key (not an open thread) is unchanged: nothing is dropped, only the new session is added', () => {
      const { hook, store } = setupWithOpenAB();
      act(() => hook.result.current.commitSuccess('new:proj-a:0', 'hello', RESULT_C));
      expect(store.openThreadIds['proj-a']).toEqual(['sess-a', 'sess-b', 'sess-c']);
      expect(store.historyLoadedFor).toEqual({ 'sess-a': true, 'sess-b': true, 'sess-c': true });
      expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toEqual(['sess-a', 'sess-b', 'sess-c']);
    });

    it('bdboard-w9hv: a successful commit clears the unobserved-origin record of the same key, and keeps another key\'s', () => {
      const { hook, params } = setupWithOpenAB();
      const marks = params.replacedMarksRef.current;
      marks.unobservedOrigins['proj-a'] = 'sess-b';
      // 別の会話キーの送信が成功しても、sess-b の記録(別の送信のもの)は消さない。
      act(() => hook.result.current.commitSuccess('sess-a', 'other', { reply: 'AI reply', sessionId: 'sess-a', agentId: 'claude' }));
      expect(marks.unobservedOrigins).toEqual({ 'proj-a': 'sess-b' });
      // 同じ会話キーの送信が成功したら、記録は意味を失うので消す。
      act(() => hook.result.current.commitSuccess('sess-b', 'hello', RESULT_C));
      expect(marks.unobservedOrigins).toEqual({});
    });

    it('not yet restored: the persisted-entry-based write drops the replaced thread too', () => {
      // 未復元では永続化済みエントリが基点 (bdboard-4w2d)。メモリの open に convKey がある
      // (この画面で先に確定したスレッド) なら、永続化側の convKey も外す。
      writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-a', 'sess-b'], selectedSessionId: 'sess-b' });
      const { hook, params, store } = setup();
      params.openThreadIdsRef.current = { 'proj-a': ['sess-b'] };
      store.openThreadIds = { 'proj-a': ['sess-b'] };
      act(() => hook.result.current.commitSuccess('sess-b', 'hello', RESULT_C));
      expect(store.openThreadIds['proj-a']).toEqual(['sess-c']);
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-c'],
        selectedSessionId: 'sess-c',
      });
    });
  });

  describe('bdboard-z9mn: the entry added to the thread list survives a list that started before the send', () => {
    it('lays the sent session over a list fetch that started before the send', () => {
      const { hook, params } = setup();
      const order = params.threadListOrder;
      const seq = order.begin('proj-a');
      act(() => hook.result.current.commitSuccess('new:proj-a:0', 'hello', RESULT));
      expect(order.admit('proj-a', seq, [{ sessionId: 'sess-a', agentId: 'claude', title: 'a', pinned: false, updatedAt: 'x' }])).toEqual([
        { sessionId: 'sess-a', agentId: 'claude', title: 'a', pinned: false, updatedAt: 'x' },
        expect.objectContaining({ sessionId: 'sess-new', title: 'hello', pinned: false }),
      ]);
    });

    it('does not lay the sent session over a list fetch that started after the send', () => {
      const { hook, params } = setup();
      const order = params.threadListOrder;
      act(() => hook.result.current.commitSuccess('new:proj-a:0', 'hello', RESULT));
      const seq = order.begin('proj-a');
      expect(order.admit('proj-a', seq, [])).toEqual([]);
    });

    it('does not lay a send into an existing thread over a list fetch that started before it, keeping the listed title and pin', () => {
      const { hook, params } = setup();
      const order = params.threadListOrder;
      const seq = order.begin('proj-a');
      const listed = { sessionId: 'sess-new', agentId: 'claude', title: 'renamed', pinned: true, updatedAt: 'x' };
      act(() => hook.result.current.commitSuccess('sess-new', 'hello', RESULT));
      expect(order.admit('proj-a', seq, [listed])).toEqual([listed]);
    });
  });

  describe('bdboard-b1rz: sending into an existing thread keeps its title and pin in the list', () => {
    const OLD_AT = '2026-01-01T00:00:00Z';
    // updatedAt は送信時刻(new Date())なので、Date だけ固定して具体値で突き合わせる。
    const SENT_AT = '2026-03-03T09:00:00.000Z';
    const renamedPinned: ChatThreadDto = {
      sessionId: 'sess-new', agentId: 'claude', title: 'My Renamed', pinned: true, updatedAt: OLD_AT,
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(SENT_AT));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps the renamed title and the pin, and only advances updatedAt', () => {
      const { hook, store } = setup();
      store.threadLists = { 'proj-a': [renamedPinned] };
      act(() => hook.result.current.commitSuccess('sess-new', 'second message', RESULT));
      expect(store.threadLists['proj-a']).toEqual([{ ...renamedPinned, updatedAt: SENT_AT }]);
    });

    // サーバーの題名は「付けた名前 ?? 最初のユーザー発言」。title が null の行は名前も保存済みメッセージも無く
    // (CLI セッションの採用直後など)、この送信がその最初の発言になるので、次のサーバー一覧と同じく送った文で埋める。
    it('fills a null title (no name and no saved message yet) with the sent text, and keeps the pin', () => {
      const { hook, store } = setup();
      store.threadLists = { 'proj-a': [{ ...renamedPinned, title: null }] };
      act(() => hook.result.current.commitSuccess('sess-new', 'second message', RESULT));
      expect(store.threadLists['proj-a']).toEqual([
        { ...renamedPinned, title: 'second message', pinned: true, updatedAt: SENT_AT },
      ]);
    });

    it('a list fetched before the send, arriving after it, still yields the renamed title and the pin (the rename record wins)', () => {
      const { hook, params, store } = setup();
      const order = params.threadListOrder;
      store.threadLists = { 'proj-a': [renamedPinned] };
      // 一覧 fetch がリネームより前に始まっていて、リネーム → 送信 の順で書き込みが起きたあとに届く。
      const seq = order.begin('proj-a');
      order.noteEntryWrite('proj-a', renamedPinned, 'replace');
      act(() => hook.result.current.commitSuccess('sess-new', 'second message', RESULT));
      const stale: ChatThreadDto = { ...renamedPinned, title: 'first message', pinned: false };
      expect(order.admit('proj-a', seq, [stale])).toEqual([renamedPinned]);
    });

    it('a list fetched before the send does not make the sent text the title of the listed thread', () => {
      const { hook, params, store } = setup();
      const order = params.threadListOrder;
      store.threadLists = { 'proj-a': [renamedPinned] };
      const seq = order.begin('proj-a');
      act(() => hook.result.current.commitSuccess('sess-new', 'second message', RESULT));
      expect(order.admit('proj-a', seq, [renamedPinned])).toEqual([renamedPinned]);
    });

    it('the first send of a draft still lays a row titled with the sent text and unpinned over an older list', () => {
      const { hook, params, store } = setup();
      const order = params.threadListOrder;
      const seq = order.begin('proj-a');
      act(() => hook.result.current.commitSuccess('new:proj-a:0', 'first message', RESULT));
      expect(store.threadLists['proj-a']).toMatchObject([{ sessionId: 'sess-new', title: 'first message', pinned: false }]);
      expect(order.admit('proj-a', seq, [])).toMatchObject([{ sessionId: 'sess-new', title: 'first message', pinned: false }]);
    });
  });

  it('records the sent model only when the model select is shown with a model', () => {
    const shown = setup({ showModelSelect: true, effectiveModelId: 'sonnet' });
    act(() => shown.hook.result.current.commitSuccess('sess-new', 'hi', RESULT));
    expect(shown.store.threadModelIds).toEqual({ 'sess-new': 'sonnet' });

    const hidden = setup({ showModelSelect: false, effectiveModelId: 'sonnet' });
    act(() => hidden.hook.result.current.commitSuccess('sess-new', 'hi', RESULT));
    expect(hidden.params.setThreadModelIds).not.toHaveBeenCalled();
  });
});

describe('commitFailure', () => {
  it('bdboard-sp2: removes only the optimistic user message stamped with sentAt and appends the error', () => {
    const { hook, store } = setup();
    store.conversations = {
      'key-a': {
        messages: [{ role: 'user', text: 'earlier', at: 5 }, { role: 'user', text: 'hello', at: 10 }],
        sessionId: 'sess-1',
        agentId: 'claude',
      },
    };
    act(() => hook.result.current.commitFailure('key-a', 'hello', [], new ApiError(409, 'busy'), 10));
    const entry = store.conversations['key-a'];
    expect(entry.messages.map((message) => (message.role === 'error' ? 'error' : message.text))).toEqual(['earlier', 'error']);
    expect(entry.sessionId).toBe('sess-1');
    expect(entry.agentId).toBe('claude');
  });

  it('clears the session on "unknown chat session"', () => {
    const { hook, store } = setup();
    store.conversations = { 'key-a': { messages: [], sessionId: 'sess-1', agentId: 'claude' } };
    act(() =>
      hook.result.current.commitFailure('key-a', 'hello', [], new ApiError(400, 'bad', { errorMessage: 'unknown chat session' }), 1),
    );
    expect(store.conversations['key-a'].sessionId).toBeUndefined();
    expect(store.conversations['key-a'].agentId).toBeUndefined();
  });

  it.each(['unknown chat session', 'chat agent mismatch'])(
    'bdboard-jwu8: leaves the persisted entry untouched on a clearSession failure (%s)',
    (errorMessage) => {
      writePersistedChatThreadState('proj-a', {
        activeSessionIds: ['sess-a', 'sess-b', 'sess-c'],
        selectedSessionId: 'sess-c',
      });
      const { hook, store } = setup();
      store.conversations = { 'sess-c': { messages: [], sessionId: 'sess-c', agentId: 'claude' } };
      act(() =>
        hook.result.current.commitFailure('sess-c', 'hello', [], new ApiError(400, 'bad', { errorMessage }), 1),
      );
      // 失敗したのは送信1回だけで、メモリ上の open/選択は変わらないので、保存も変えない。
      // 選択 sess-c も残す (unknown chat session なら復元時に restoreThreadView が落とす)。
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-c'],
        selectedSessionId: 'sess-c',
      });
    },
  );

  it('bdboard-jwu8: does not create an entry on a clearSession failure when none was persisted (first visit stays first visit)', () => {
    const { hook, store } = setup();
    store.conversations = { 'sess-c': { messages: [], sessionId: 'sess-c', agentId: 'claude' } };
    act(() =>
      hook.result.current.commitFailure(
        'sess-c',
        'hello',
        [],
        new ApiError(400, 'bad', { errorMessage: 'unknown chat session' }),
        1,
      ),
    );
    expect(readPersistedChatThreads()['proj-a']).toBeUndefined();
  });

  it('bdboard-jwu8: a re-send after a clearSession failure does not shrink the persisted open set to just the new session', () => {
    writePersistedChatThreadState('proj-a', {
      activeSessionIds: ['sess-a', 'sess-b', 'sess-c'],
      selectedSessionId: 'sess-c',
    });
    const { hook, store } = setup();
    store.conversations = { 'sess-c': { messages: [], sessionId: 'sess-c', agentId: 'claude' } };
    act(() =>
      hook.result.current.commitFailure(
        'sess-c',
        'hello',
        [],
        new ApiError(400, 'bad', { errorMessage: 'unknown chat session' }),
        1,
      ),
    );
    // Re-send on the same conv key; the server issues a fresh session id.
    act(() =>
      hook.result.current.commitSuccess('sess-c', 'hello', { reply: 'AI reply', sessionId: 'sess-c2', agentId: 'claude' }),
    );
    // 失敗時に activeSessionIds は触らない (jwu8)。この store ではメモリの open が空
    // (openThreadIdsRef に sess-c が無い) ので置き換えとは扱われず、永続化済みの sess-c が残る。
    // 開いているスレッドの置き換え (sess-c がメモリの open にある) で外れることは、
    // 上の bdboard-drfb のテストが固定する。
    expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toEqual(['sess-a', 'sess-b', 'sess-c', 'sess-c2']);
  });

  it('bdboard-otf/SF2: restores the untrimmed text and the attachments into the send key when they are empty', () => {
    const { hook, store } = setup();
    act(() => hook.result.current.commitFailure('key-a', 'PROJ-1 について: ', [IMAGE], new Error('boom'), 1));
    expect(store.inputs['key-a']).toBe('PROJ-1 について: ');
    expect(store.attachments['key-a']).toEqual([IMAGE]);
  });

  it('dpq: does not overwrite text or attachments typed into the send key meanwhile', () => {
    const { hook, store, params } = setup();
    store.inputs['key-a'] = 'typed later';
    store.attachments['key-a'] = [{ ...IMAGE, id: 'att-later' }];
    act(() => hook.result.current.commitFailure('key-a', 'hello', [IMAGE], new Error('boom'), 1));
    expect(params.setInput).not.toHaveBeenCalled();
    expect(params.updateConversationAttachments).not.toHaveBeenCalled();
  });
});

describe('reference stability', () => {
  it('keeps all three actions stable across renders while the inputs do not change', () => {
    const { hook, params } = setup();
    const before = hook.result.current;
    hook.rerender({ ...params });
    expect(hook.result.current.commitSuccess).toBe(before.commitSuccess);
    expect(hook.result.current.commitFailure).toBe(before.commitFailure);
    expect(hook.result.current.appendTranscript).toBe(before.appendTranscript);
  });

  it('recreates commitSuccess/commitFailure (not appendTranscript) when the project changes', () => {
    const { hook, params } = setup();
    const before = hook.result.current;
    hook.rerender({ ...params, selectedProjectId: 'proj-b' });
    expect(hook.result.current.commitSuccess).not.toBe(before.commitSuccess);
    expect(hook.result.current.commitFailure).not.toBe(before.commitFailure);
    expect(hook.result.current.appendTranscript).toBe(before.appendTranscript);
  });
});
