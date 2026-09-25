import { act, renderHook } from '@testing-library/react';
import type { SetStateAction } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageResponseDto, ChatThreadDto } from '../../api';

// bdboard-sso1.83 第13b段: chat/useChatSendCommits.ts の store 側 action
// (commitSuccess = 旧 applyChatSuccess、commitFailure = 旧 applyChatError、
// appendTranscript = 旧 submitChatMessage の2箇所の setConversations)を直接固定する。
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, acknowledgeChatTurn: vi.fn(() => Promise.resolve()) };
});

import { acknowledgeChatTurn, ApiError } from '../../api';
import type { ChatAttachment } from './attachments';
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
  // 計算するようになった(render-mirror の同期漏れ対策)。この probe では
  // store.openThreadIds を直接は読まない単純な ref で足りる(既存テストはどれも
  // 事前に開いているスレッドを想定しないため)。
  const openThreadIdsRef = { current: {} as Record<string, string[]> };
  // bdboard-d7on(Opus レビュー B1/M1 対応): commitSuccess は selectedThreadIdsRef も
  // 同じ場所で同期するようになった。既存テストはどれも ref の事前値を読まないので
  // 単純な空 ref で足りる。
  const selectedThreadIdsRef = { current: {} as Record<string, string | undefined> };
  const params: UseChatSendCommitsParams = {
    selectedProjectId: 'proj-a',
    showModelSelect: false,
    effectiveModelId: '',
    setConversations: setterFor(store, 'conversations'),
    setHistoryLoadedFor: setterFor(store, 'historyLoadedFor'),
    setThreadModelIds: setterFor(store, 'threadModelIds'),
    setThreadLists: setterFor(store, 'threadLists'),
    setOpenThreadIds: setterFor(store, 'openThreadIds'),
    openThreadIdsRef,
    setSelectedThreadIds: setterFor(store, 'selectedThreadIds'),
    selectedThreadIdsRef,
    conversationInputsRef,
    conversationAttachmentsRef,
    setInput: vi.fn((key: string, value: string) => { store.inputs[key] = value; }),
    updateConversationAttachments: vi.fn(
      (updater: (prev: Record<string, ChatAttachment[]>) => Record<string, ChatAttachment[]>) => {
        store.attachments = updater(store.attachments);
      },
    ),
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
    // bdboard-d7on(Opus レビュー B1/M1): setState と同じ場所で openThreadIdsRef/
    // selectedThreadIdsRef も同期していることを、state だけでなく ref 自体でも
    // 確認する(同 tick で ref を読む他ハンドラの安全性はここでしか検証できない)。
    expect(params.openThreadIdsRef.current).toEqual({ 'proj-a': ['sess-new'] });
    expect(params.selectedThreadIdsRef.current).toEqual({ 'proj-a': 'sess-new' });
    expect(ackMock).toHaveBeenCalledWith('proj-a', 'sess-new');
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
