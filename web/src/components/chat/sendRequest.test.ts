import { describe, expect, it } from 'vitest';
import type { ChatAttachment } from './attachments';
import { buildChatMessageRequest, buildOptimisticUserMessage, resolveSendSessionId } from './sendRequest';

// bdboard-sso1.83 第13b段: chat/sendRequest.ts の純関数を分岐ごとに固定する。
// 元は ChatPanel.tsx の submitChatMessage の中にあった式で、ChatPanel 経由の
// 結合テスト(pbf のフォールバック、エージェント切替、モデル送信、画像のみ送信)
// とは別に、ここで分岐ごとの入出力を1つずつ見る。

function attachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: 'att-1',
    file: new File(['x'], 'a.png', { type: 'image/png' }),
    mimeType: 'image/png',
    previewUrl: 'data:image/png;base64,QUJD',
    name: 'a.png',
    size: 3,
    ...overrides,
  };
}

describe('resolveSendSessionId', () => {
  it('uses the conversation sessionId when the agents match', () => {
    expect(resolveSendSessionId({ messages: [], sessionId: 'sess-1', agentId: 'claude' }, 'sess-current', 'claude')).toBe(
      'sess-1',
    );
  });

  it('bdboard-pbf: falls back to currentSessionId only when the conversation does not exist yet', () => {
    expect(resolveSendSessionId(undefined, 'sess-current', 'claude')).toBe('sess-current');
    expect(resolveSendSessionId(undefined, undefined, 'claude')).toBeUndefined();
  });

  it('bdboard-pbf: does not fall back when the conversation exists with a cleared sessionId (clearSession)', () => {
    expect(resolveSendSessionId({ messages: [], agentId: 'claude' }, 'sess-current', 'claude')).toBeUndefined();
    expect(resolveSendSessionId({ messages: [] }, 'sess-current', 'claude')).toBeUndefined();
  });

  it('treats a conversation without agentId as matching any agent', () => {
    expect(resolveSendSessionId({ messages: [], sessionId: 'sess-1' }, undefined, 'codex')).toBe('sess-1');
  });

  it('treats an empty selectedAgentId as matching any conversation agent', () => {
    expect(resolveSendSessionId({ messages: [], sessionId: 'sess-1', agentId: 'codex' }, undefined, '')).toBe('sess-1');
  });

  it('sends no sessionId when the conversation belongs to another agent, with or without a fallback', () => {
    expect(
      resolveSendSessionId({ messages: [], sessionId: 'sess-1', agentId: 'codex' }, 'sess-current', 'claude'),
    ).toBeUndefined();
  });
});

describe('buildChatMessageRequest', () => {
  const base = {
    projectId: 'proj-a',
    message: 'hello',
    sessionId: undefined,
    selectedAgentId: '',
    showModelSelect: false,
    effectiveModelId: '',
    attachments: [],
  };

  it('has only projectId and message when nothing optional applies', () => {
    expect(JSON.stringify(buildChatMessageRequest(base))).toBe('{"projectId":"proj-a","message":"hello"}');
  });

  it('adds sessionId only when it is defined', () => {
    expect(buildChatMessageRequest({ ...base, sessionId: 'sess-1' })).toEqual({
      projectId: 'proj-a',
      message: 'hello',
      sessionId: 'sess-1',
    });
    expect('sessionId' in buildChatMessageRequest(base)).toBe(false);
  });

  it('adds agentId only when an agent is selected', () => {
    expect(buildChatMessageRequest({ ...base, selectedAgentId: 'claude' }).agentId).toBe('claude');
    expect('agentId' in buildChatMessageRequest(base)).toBe(false);
  });

  it('adds model only when the model select is shown and a model is chosen', () => {
    expect(buildChatMessageRequest({ ...base, showModelSelect: true, effectiveModelId: 'sonnet' }).model).toBe('sonnet');
    expect('model' in buildChatMessageRequest({ ...base, showModelSelect: true, effectiveModelId: '' })).toBe(false);
    expect('model' in buildChatMessageRequest({ ...base, showModelSelect: false, effectiveModelId: 'sonnet' })).toBe(
      false,
    );
  });

  it('adds images from the already-read data URLs only when there are attachments', () => {
    const request = buildChatMessageRequest({ ...base, attachments: [attachment()] });
    expect(request.images).toEqual([{ mimeType: 'image/png', data: 'QUJD' }]);
    expect('images' in buildChatMessageRequest(base)).toBe(false);
  });

  it('keeps the key order projectId, message, sessionId, agentId, model, images', () => {
    const request = buildChatMessageRequest({
      projectId: 'proj-a',
      message: 'hello',
      sessionId: 'sess-1',
      selectedAgentId: 'claude',
      showModelSelect: true,
      effectiveModelId: 'sonnet',
      attachments: [attachment()],
    });
    expect(Object.keys(request)).toEqual(['projectId', 'message', 'sessionId', 'agentId', 'model', 'images']);
  });

  it('throws when an attachment preview is not a data URL (the caller turns it into an attachment error)', () => {
    expect(() => buildChatMessageRequest({ ...base, attachments: [attachment({ previewUrl: 'blob-without-comma' })] })).toThrow(
      '画像を送信形式に変換できませんでした。',
    );
  });
});

describe('buildOptimisticUserMessage', () => {
  it('is a user message stamped with sentAt and without images when nothing is attached', () => {
    const message = buildOptimisticUserMessage('hello', 1234, []);
    expect(message).toEqual({ role: 'user', text: 'hello', at: 1234 });
    expect('images' in message).toBe(false);
  });

  it('carries only previewUrl/name/size of each attachment', () => {
    expect(buildOptimisticUserMessage('look', 99, [attachment(), attachment({ id: 'att-2', name: 'b.png', size: 7 })])).toEqual(
      {
        role: 'user',
        text: 'look',
        at: 99,
        images: [
          { previewUrl: 'data:image/png;base64,QUJD', name: 'a.png', size: 3 },
          { previewUrl: 'data:image/png;base64,QUJD', name: 'b.png', size: 7 },
        ],
      },
    );
  });
});
