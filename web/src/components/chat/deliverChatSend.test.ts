import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageResponseDto } from '../../api';

// bdboard-sso1.83 第13b段: chat/deliverChatSend.ts(旧 submitChatMessage の try の中身)
// を分岐ごとに固定する。ChatPanel 経由の結合テスト(send-stream-basics / stream-abort /
// turn-status-recovery-1/2)が同じ挙動を画面越しに見ているが、ここでは
// 「どの setter をどの引数で呼ぶか」を直接見る。
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    postChatMessage: vi.fn(),
    postChatMessageStream: vi.fn(),
    acknowledgeChatTurn: vi.fn(() => Promise.resolve()),
  };
});

import { acknowledgeChatTurn, ChatStreamEndedWithoutResultError, postChatMessage, postChatMessageStream } from '../../api';
import { deliverChatSend, type DeliverChatSendParams } from './deliverChatSend';
import { CHAT_STREAM_DETACHED_FAILED_MESSAGE } from './turnStatusPolicy';
import type { DetachedStreamSend } from './useChatSendState';

const postMock = vi.mocked(postChatMessage);
const streamMock = vi.mocked(postChatMessageStream);
const ackMock = vi.mocked(acknowledgeChatTurn);

const RESULT: ChatMessageResponseDto = { reply: 'hi', sessionId: 'sess-1', agentId: 'claude' };

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

function setup(overrides: Partial<DeliverChatSendParams> = {}, detached: Record<string, DetachedStreamSend> = {}) {
  const store = { streaming: { other: 'keep me' } as Record<string, string>, generation: 0 };
  const events: string[] = [];
  const detachedStreamSendRef = { current: detached };
  const send = {
    setStreamingReply: vi.fn((updater: (prev: Record<string, string>) => Record<string, string>) => {
      store.streaming = updater(store.streaming);
    }),
    setTurnRecoveryGeneration: vi.fn((updater: (prev: number) => number) => {
      store.generation = updater(store.generation);
    }),
    markUnresolvedSend: vi.fn(),
    clearStreamingReplyForKey: vi.fn((key: string) => {
      events.push(`clear:${key}`);
    }),
    detachedStreamSendRef,
  };
  const onSuccess = vi.fn<(result: ChatMessageResponseDto) => void>(() => {
    events.push('success');
  });
  const onFailure = vi.fn<(error: unknown) => void>(() => {
    events.push('failure');
  });
  const params: DeliverChatSendParams = {
    payload: { projectId: 'proj-a', message: 'hello' },
    streaming: false,
    signal: new AbortController().signal,
    projectId: 'proj-a',
    sendKey: 'key-a',
    sessionId: 'sess-1',
    onSuccess,
    onFailure,
    send,
    ...overrides,
  };
  return { params, store, events, send, onSuccess, onFailure, detachedStreamSendRef };
}

function earlierDetached(sessionId: string | undefined): DetachedStreamSend {
  return { sessionId, streamingKey: 'key-earlier', detachedAt: 1, fail: vi.fn() };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('deliverChatSend — non-streaming', () => {
  it('commits the result and then settles an earlier detached send of the same project (bdboard-zlzo)', async () => {
    postMock.mockResolvedValue(RESULT);
    const { params, events, onSuccess, detachedStreamSendRef } = setup({}, { 'proj-a': earlierDetached('sess-0') });
    await deliverChatSend(params);
    expect(postMock).toHaveBeenCalledWith(params.payload, params.signal);
    expect(onSuccess).toHaveBeenCalledWith(RESULT);
    expect(events).toEqual(['success', 'clear:key-earlier']);
    expect(detachedStreamSendRef.current).toEqual({});
  });

  it('bumps the recovery generation and marks the session on AbortError, without a failure commit', async () => {
    postMock.mockRejectedValue(abortError());
    const { params, store, send, onFailure } = setup();
    await deliverChatSend(params);
    expect(store.generation).toBe(1);
    expect(send.markUnresolvedSend).toHaveBeenCalledWith('sess-1');
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('commits the failure without an ACK and keeps an earlier detached send on a normal error', async () => {
    const error = new Error('boom');
    postMock.mockRejectedValue(error);
    const detached = earlierDetached('sess-0');
    const { params, onFailure, detachedStreamSendRef } = setup({}, { 'proj-a': detached });
    await deliverChatSend(params);
    expect(onFailure).toHaveBeenCalledWith(error);
    expect(ackMock).not.toHaveBeenCalled();
    expect(detachedStreamSendRef.current['proj-a']).toBe(detached);
  });
});

describe('deliverChatSend — streaming', () => {
  it('bdboard-1qoe: resets and accumulates deltas only under sendKey, then clears only sendKey', async () => {
    const { params, store, events } = setup({ streaming: true });
    streamMock.mockImplementation((_payload, handlers) => {
      handlers.onDelta('Hel');
      handlers.onDelta('lo');
      expect(store.streaming).toEqual({ other: 'keep me', 'key-a': 'Hello' });
      return Promise.resolve(RESULT);
    });
    await deliverChatSend(params);
    expect(events).toEqual(['success', 'clear:key-a']);
    expect(store.streaming.other).toBe('keep me');
  });

  it('starts sendKey from an empty string even if a stale partial text is there', async () => {
    const { params, store } = setup({ streaming: true });
    store.streaming = { 'key-a': 'stale' };
    streamMock.mockImplementation((_payload, handlers) => {
      handlers.onDelta('x');
      return Promise.resolve(RESULT);
    });
    await deliverChatSend(params);
    expect(params.send.setStreamingReply).toHaveBeenCalledTimes(2);
    expect(store.streaming['key-a']).toBe('x');
  });

  it('on AbortError bumps the generation, marks the session and still clears sendKey, without a failure commit', async () => {
    streamMock.mockRejectedValue(abortError());
    const { params, store, send, events, onFailure } = setup({ streaming: true });
    await deliverChatSend(params);
    expect(store.generation).toBe(1);
    expect(send.markUnresolvedSend).toHaveBeenCalledWith('sess-1');
    expect(events).toEqual(['clear:key-a']);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('bdboard-zlzo/3tw.166: a detached stream records fail(), keeps the partial text and defers the failure', async () => {
    const detachError = new ChatStreamEndedWithoutResultError();
    streamMock.mockRejectedValue(detachError);
    const { params, store, send, events, onFailure, detachedStreamSendRef } = setup({ streaming: true });
    await deliverChatSend(params);
    const entry = detachedStreamSendRef.current['proj-a'];
    expect(entry).toMatchObject({ sessionId: 'sess-1', streamingKey: 'key-a' });
    expect(typeof entry.detachedAt).toBe('number');
    expect(store.generation).toBe(1);
    expect(send.markUnresolvedSend).toHaveBeenCalledWith('sess-1');
    expect(events).toEqual([]);
    expect(onFailure).not.toHaveBeenCalled();

    entry.fail();
    expect(onFailure).toHaveBeenCalledTimes(1);
    const failure = onFailure.mock.calls[0][0] as Error;
    expect(failure.message).toBe(CHAT_STREAM_DETACHED_FAILED_MESSAGE);
    expect(failure.cause).toBe(detachError);
  });

  it('bdboard-w26w: ACKs the turn and commits the failure on a normal streaming error', async () => {
    const error = new Error('inline sse error');
    streamMock.mockRejectedValue(error);
    const { params, events, onFailure } = setup({ streaming: true });
    await deliverChatSend(params);
    expect(ackMock).toHaveBeenCalledWith('proj-a', 'sess-1');
    expect(onFailure).toHaveBeenCalledWith(error);
    expect(events).toEqual(['failure', 'clear:key-a']);
  });

  it('bdboard-w26w: skips the ACK when there is no sessionId yet', async () => {
    streamMock.mockRejectedValue(new Error('first send failed'));
    const { params, onFailure } = setup({ streaming: true, sessionId: undefined });
    await deliverChatSend(params);
    expect(ackMock).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('bdboard-w26w: skips the ACK while a detached send of the same project and session is unresolved', async () => {
    streamMock.mockRejectedValue(new Error('boom'));
    const { params, detachedStreamSendRef } = setup({ streaming: true }, { 'proj-a': earlierDetached('sess-1') });
    await deliverChatSend(params);
    expect(ackMock).not.toHaveBeenCalled();
    expect(detachedStreamSendRef.current['proj-a']).toBeDefined();
  });

  it('bdboard-w26w: still ACKs when the unresolved detached send is for another session', async () => {
    streamMock.mockRejectedValue(new Error('boom'));
    const { params } = setup({ streaming: true }, { 'proj-a': earlierDetached('sess-other') });
    await deliverChatSend(params);
    expect(ackMock).toHaveBeenCalledWith('proj-a', 'sess-1');
  });

  it('swallows a failed ACK', async () => {
    streamMock.mockRejectedValue(new Error('boom'));
    ackMock.mockRejectedValue(new Error('ack failed'));
    const { params, onFailure } = setup({ streaming: true });
    await expect(deliverChatSend(params)).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('settles an earlier detached send after a streaming success', async () => {
    streamMock.mockResolvedValue(RESULT);
    const { params, events, detachedStreamSendRef } = setup({ streaming: true }, { 'proj-a': earlierDetached('sess-0') });
    await deliverChatSend(params);
    expect(events).toEqual(['success', 'clear:key-earlier', 'clear:key-a']);
    expect(detachedStreamSendRef.current).toEqual({});
  });

  it('rethrows what a commit throws, after clearing sendKey in the finally', async () => {
    streamMock.mockRejectedValue(new Error('boom'));
    const { params, events } = setup({
      streaming: true,
      onFailure: () => {
        events.push('failure');
        throw new Error('commit exploded');
      },
    });
    await expect(deliverChatSend(params)).rejects.toThrow('commit exploded');
    expect(events).toEqual(['failure', 'clear:key-a']);
  });
});
