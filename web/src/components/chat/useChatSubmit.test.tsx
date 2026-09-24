import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatMessageResponseDto } from '../../api';

// bdboard-sso1.83 第13b段: chat/useChatSubmit.ts の submit/handleSubmit を直接固定する。
// POST とその結果の振り分けは deliverChatSend.test.ts、ChatPanel 越しの挙動は
// ChatPanel.submit-characterization ほかの結合テストが見る。ここはガードの順番、
// 楽観的な書き込み・入力欄クリアの順番、sendKey の確定、controller の後始末、
// 送信後の focus が isSending=false の反映後に来ること(bdboard-dcyi)を見る。
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    postChatMessage: vi.fn(),
    postChatMessageStream: vi.fn(),
    acknowledgeChatTurn: vi.fn(() => Promise.resolve()),
  };
});

import { postChatMessage } from '../../api';
import { CHAT_AGENT_UNAVAILABLE_WARNING } from '../../writeAccessMessage';
import { CHAT_IMAGE_ONLY_PROMPT, type ChatAttachment } from './attachments';
import { useChatSubmit, type ChatSubmitContext, type UseChatSubmitParams } from './useChatSubmit';
import type { UseChatSendStateResult } from './useChatSendState';

const postMock = vi.mocked(postChatMessage);
const RESULT: ChatMessageResponseDto = { reply: 'hi', sessionId: 'sess-new', agentId: 'claude' };
const AGENT: ChatAgentDto = {
  id: 'claude', label: 'Claude', experimental: false, capability: 'bd-only',
  availability: 'available', supportsStreaming: false, supportsImages: false,
};
const IMAGE: ChatAttachment = {
  id: 'att-1', file: new File(['x'], 'a.png', { type: 'image/png' }), mimeType: 'image/png',
  previewUrl: 'data:image/png;base64,QUJD', name: 'a.png', size: 3,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(contextOverrides: Partial<ChatSubmitContext> = {}, sendOverrides: Partial<UseChatSendStateResult> = {}) {
  const events: string[] = [];
  const log = (name: string) => vi.fn((...args: unknown[]) => { events.push(`${name}:${JSON.stringify(args)}`); });
  const send: UseChatSendStateResult = {
    isSending: false, streamingReply: {}, turnRecoveryGeneration: 0, unresolvedSends: {},
    setIsSending: log('setIsSending'), setStreamingReply: vi.fn(), setTurnRecoveryGeneration: vi.fn(),
    clearStreamingReplyForKey: vi.fn(), markUnresolvedSend: log('markUnresolvedSend'), clearUnresolvedSend: vi.fn(),
    detachedStreamSendRef: { current: {} }, requestAbortControllerRef: { current: null },
    ...sendOverrides,
  };
  const focus = vi.fn(() => { events.push('focus'); });
  // bdboard-dcyi: effect が ownerDocument/form を読むので本物の textarea を使う(document には
  // 付けない。activeElement は body のまま = フォーカスがどこにも無い状態)。
  const textarea = document.createElement('textarea');
  textarea.focus = focus;
  const context: ChatSubmitContext = {
    selectedProjectId: 'proj-a', currentConversationKey: 'key-a', currentSessionId: undefined,
    conversations: { 'key-a': { messages: [], sessionId: 'sess-1', agentId: 'claude' } },
    selectedAgentId: 'claude', selectedAgent: AGENT, selectedAgentUnavailable: false,
    showModelSelect: false, effectiveModelId: '', isHistoryPending: false,
    currentInput: '  hello ', currentAttachments: [],
    ...contextOverrides,
  };
  const params: UseChatSubmitParams = {
    context,
    draft: { setInput: log('setInput'), updateConversationAttachments: log('updateConversationAttachments'), setAttachmentError: log('setAttachmentError') },
    send,
    commitSuccess: log('commitSuccess'),
    commitFailure: log('commitFailure'),
    appendTranscript: log('appendTranscript'),
    resetBackgroundTurnStatus: log('resetBackgroundTurnStatus'),
    inputRef: { current: textarea },
  };
  const hook = renderHook((props: UseChatSubmitParams) => useChatSubmit(props), { initialProps: params });
  return { hook, params, send, events };
}

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe('useChatSubmit guards', () => {
  it('checks an unavailable agent first and adds the warning bubble for non-empty input, even while sending', async () => {
    const { hook, params, events } = setup({ selectedAgentUnavailable: true, selectedProjectId: '' }, { isSending: true });
    await act(() => hook.result.current.submit('hello', 'hello', []));
    expect(params.appendTranscript).toHaveBeenCalledWith('key-a', expect.objectContaining({ role: 'error', text: CHAT_AGENT_UNAVAILABLE_WARNING }));
    expect(events).toHaveLength(1);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('adds nothing for an unavailable agent when the input is empty', async () => {
    const { hook, events } = setup({ selectedAgentUnavailable: true });
    await act(() => hook.result.current.submit('', '', []));
    expect(events).toEqual([]);
  });

  it.each([
    ['empty text and no attachments', {}, {}, ''],
    ['already sending', {}, { isSending: true }, 'hello'],
    ['no project selected', { selectedProjectId: '' }, {}, 'hello'],
    ['history still loading', { isHistoryPending: true }, {}, 'hello'],
  ] as const)('does nothing when %s', async (_label, context, send, text) => {
    const { hook, events } = setup(context, send);
    await act(() => hook.result.current.submit(text, text, []));
    expect(events).toEqual([]);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('bdboard-v3ag: reads the unresolved detached send from the ref at click time, not at render time', async () => {
    const { hook, send, events } = setup();
    send.detachedStreamSendRef.current['proj-a'] = { sessionId: 'sess-0', streamingKey: 'key-0', detachedAt: 1, fail: vi.fn() };
    await act(() => hook.result.current.submit('hello', 'hello', []));
    expect(events).toEqual([]);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('does nothing when images are attached but the agent cannot take images', async () => {
    const { hook, events } = setup();
    await act(() => hook.result.current.submit('look', 'look', [IMAGE]));
    expect(events).toEqual([]);
  });

  it('reports an attachment error and sends nothing when an image cannot be converted', async () => {
    const { hook, params, events } = setup({ selectedAgent: { ...AGENT, supportsImages: true } });
    await act(() => hook.result.current.submit('look', 'look', [{ ...IMAGE, previewUrl: 'no-comma' }]));
    expect(params.draft.setAttachmentError).toHaveBeenCalledWith('key-a', '画像を送信形式に変換できませんでした。');
    expect(events).toHaveLength(1);
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe('useChatSubmit send lifecycle', () => {
  it('writes the optimistic message, clears the draft before the request, and leaves focus to the effect (not the finally)', async () => {
    postMock.mockResolvedValue(RESULT);
    const { hook, params, events } = setup({ currentAttachments: [] });
    await act(() => hook.result.current.submit('hello', '  hello ', []));
    const names = events.map((event) => event.split(':')[0]);
    expect(names).toEqual([
      'appendTranscript', 'setInput', 'updateConversationAttachments', 'resetBackgroundTurnStatus',
      'setIsSending', 'commitSuccess', 'setIsSending',
    ]);
    const [key, optimistic, sessionId] = vi.mocked(params.appendTranscript).mock.calls[0];
    expect([key, sessionId]).toEqual(['key-a', 'sess-1']);
    expect(optimistic).toEqual({ role: 'user', text: 'hello', at: optimistic.at });
    expect(typeof optimistic.at).toBe('number');
    expect(events[1]).toBe('setInput:["key-a",""]');
    expect(events[4]).toBe('setIsSending:[true]');
    expect(events[6]).toBe('setIsSending:[false]');
    expect(postMock.mock.calls[0][0]).toEqual({ projectId: 'proj-a', message: 'hello', sessionId: 'sess-1', agentId: 'claude' });
  });

  it('writes to the conversation key captured at submit time even after a rerender with another key', async () => {
    const pending = deferred<ChatMessageResponseDto>();
    postMock.mockReturnValue(pending.promise);
    const { hook, params } = setup();
    let sending!: Promise<void>;
    act(() => { sending = hook.result.current.submit('hello', 'hello', []); });
    hook.rerender({ ...params, context: { ...params.context, currentConversationKey: 'key-b' } });
    await act(async () => { pending.resolve(RESULT); await sending; });
    expect(params.commitSuccess).toHaveBeenCalledWith('key-a', 'hello', RESULT);
  });

  it('passes the untrimmed text, the attachments and sentAt (the optimistic message at) to commitFailure', async () => {
    const error = new Error('boom');
    postMock.mockRejectedValue(error);
    const { hook, params } = setup({ selectedAgent: { ...AGENT, supportsImages: true } });
    await act(() => hook.result.current.submit('look', '  look ', [IMAGE]));
    const optimistic = vi.mocked(params.appendTranscript).mock.calls[0][1];
    expect(params.commitFailure).toHaveBeenCalledWith('key-a', '  look ', [IMAGE], error, optimistic.at);
    expect(optimistic.images).toEqual([{ previewUrl: IMAGE.previewUrl, name: 'a.png', size: 3 }]);
  });

  it('does not restore the draft on AbortError (the clear before the request stands)', async () => {
    postMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const { hook, params } = setup();
    await act(() => hook.result.current.submit('hello', 'hello', []));
    expect(params.commitFailure).not.toHaveBeenCalled();
    expect(params.draft.setInput).toHaveBeenCalledTimes(1);
    expect(params.send.markUnresolvedSend).toHaveBeenCalledWith('sess-1');
  });

  it('holds its controller in requestAbortControllerRef while in flight and clears it afterwards', async () => {
    const pending = deferred<ChatMessageResponseDto>();
    postMock.mockReturnValue(pending.promise);
    const { hook, send } = setup();
    let sending!: Promise<void>;
    act(() => { sending = hook.result.current.submit('hello', 'hello', []); });
    const controller = send.requestAbortControllerRef.current;
    expect(controller).toBeInstanceOf(AbortController);
    expect(postMock.mock.calls[0][1]).toBe(controller?.signal);
    await act(async () => { pending.resolve(RESULT); await sending; });
    expect(send.requestAbortControllerRef.current).toBeNull();
  });

  it('leaves a newer controller in the ref alone when its own request settles', async () => {
    const pending = deferred<ChatMessageResponseDto>();
    postMock.mockReturnValue(pending.promise);
    const { hook, send } = setup();
    let sending!: Promise<void>;
    act(() => { sending = hook.result.current.submit('hello', 'hello', []); });
    const newer = new AbortController();
    send.requestAbortControllerRef.current = newer;
    await act(async () => { pending.resolve(RESULT); await sending; });
    expect(send.requestAbortControllerRef.current).toBe(newer);
  });

  it('clears the ref unconditionally, still runs the finally and rethrows an unexpected failure', async () => {
    postMock.mockRejectedValue(new Error('boom'));
    const { hook, params, send, events } = setup();
    vi.mocked(params.commitFailure).mockImplementation(() => {
      send.requestAbortControllerRef.current = new AbortController();
      throw new Error('unexpected');
    });
    let caught: unknown;
    await act(async () => { await hook.result.current.submit('hello', 'hello', []).catch((error: unknown) => { caught = error; }); });
    expect((caught as Error).message).toBe('unexpected');
    expect(send.requestAbortControllerRef.current).toBeNull();
    expect(events.slice(-1)).toEqual(['setIsSending:[false]']);
  });
});

// bdboard-dcyi: finally の中の同期 focus() は、textarea がまだ disabled(=isSending)の
// うちに呼ばれて無視されていた。focus は isSending=false が反映された後の effect で戻す。
describe('useChatSubmit focus after a send (bdboard-dcyi)', () => {
  it('focuses once isSending=false is rendered after its own send, and only once', async () => {
    postMock.mockResolvedValue(RESULT);
    const { hook, params, send, events } = setup();
    await act(() => hook.result.current.submit('hello', 'hello', []));
    expect(events).not.toContain('focus');

    hook.rerender({ ...params, send: { ...send, isSending: true } });
    expect(events).not.toContain('focus');
    hook.rerender({ ...params, send: { ...send, isSending: false } });
    expect(events.filter((event) => event === 'focus')).toHaveLength(1);

    hook.rerender({ ...params, send: { ...send, isSending: true } });
    hook.rerender({ ...params, send: { ...send, isSending: false } });
    expect(events.filter((event) => event === 'focus')).toHaveLength(1);
  });

  it('does not focus when isSending goes back to false without a send of its own finishing', () => {
    const { hook, params, send, events } = setup();
    hook.rerender({ ...params, send: { ...send, isSending: true } });
    hook.rerender({ ...params, send: { ...send, isSending: false } });
    expect(events).not.toContain('focus');
  });
});

describe('useChatSubmit handleSubmit', () => {
  it('prevents the default, sends the trimmed input and keeps the raw input for the restore', async () => {
    postMock.mockRejectedValue(new Error('boom'));
    const { hook, params } = setup({ currentInput: '  hello ' });
    const preventDefault = vi.fn();
    await act(() => hook.result.current.handleSubmit({ preventDefault } as unknown as FormEvent));
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(postMock.mock.calls[0][0].message).toBe('hello');
    expect(vi.mocked(params.commitFailure).mock.calls[0][1]).toBe('  hello ');
  });

  it('sends the image-only prompt when only images are attached', async () => {
    postMock.mockResolvedValue(RESULT);
    const { hook } = setup({ currentInput: '   ', currentAttachments: [IMAGE], selectedAgent: { ...AGENT, supportsImages: true } });
    await act(() => hook.result.current.handleSubmit({ preventDefault: vi.fn() } as unknown as FormEvent));
    expect(postMock.mock.calls[0][0].message).toBe(CHAT_IMAGE_ONLY_PROMPT);
  });
});
