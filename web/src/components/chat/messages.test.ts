import { describe, expect, it } from 'vitest';
import type { ChatMessageResponseDto, ChatSessionMessageDto } from '../../api';
import { toAssistantMessage, toChatMessages } from './messages';

// bdboard-sso1.83 第4段: turn-status 回収(E8)・履歴 fetch(E12)・未回収の取り直し
// (E13) の3箇所で重複していた変換を toChatMessages/toAssistantMessage へ寄せた際に
// 足したテスト。
describe('toChatMessages', () => {
  it('空配列はそのまま空配列を返す', () => {
    expect(toChatMessages([])).toEqual([]);
  });

  it('role/content/createdAt を role/text/at(ミリ秒)へ変換する', () => {
    const dtos: ChatSessionMessageDto[] = [
      { role: 'user', content: 'hello', createdAt: '2026-09-24T00:00:00.000Z' },
      { role: 'assistant', content: 'hi', createdAt: '2026-09-24T00:00:01.000Z' },
    ];
    expect(toChatMessages(dtos)).toEqual([
      { role: 'user', text: 'hello', at: Date.parse('2026-09-24T00:00:00.000Z') },
      { role: 'assistant', text: 'hi', at: Date.parse('2026-09-24T00:00:01.000Z') },
    ]);
  });

  it('failedTools/agentWarnings が空配列のときはキー自体を省く', () => {
    const dtos: ChatSessionMessageDto[] = [
      {
        role: 'assistant',
        content: 'ok',
        createdAt: '2026-09-24T00:00:00.000Z',
        failedTools: [],
        agentWarnings: [],
      },
    ];
    const [message] = toChatMessages(dtos);
    expect(message).not.toHaveProperty('failedTools');
    expect(message).not.toHaveProperty('agentWarnings');
  });

  it('failedTools/agentWarnings に中身があるときはそのまま含める', () => {
    const dtos: ChatSessionMessageDto[] = [
      {
        role: 'assistant',
        content: 'ok',
        createdAt: '2026-09-24T00:00:00.000Z',
        failedTools: ['bd_create'],
        agentWarnings: ['warn1'],
      },
    ];
    const [message] = toChatMessages(dtos);
    expect(message.failedTools).toEqual(['bd_create']);
    expect(message.agentWarnings).toEqual(['warn1']);
  });
});

describe('toAssistantMessage', () => {
  it('result.reply/呼び出し元が渡した at からアシスタント発話を組み立てる', () => {
    const result: ChatMessageResponseDto = {
      reply: 'こんにちは',
      sessionId: 'sess-1',
      agentId: 'agent-1',
    };
    expect(toAssistantMessage(result, 12345)).toEqual({
      role: 'assistant',
      text: 'こんにちは',
      at: 12345,
    });
  });

  it('failedTools/agentWarnings が空配列のときはキー自体を省く', () => {
    const result: ChatMessageResponseDto = {
      reply: 'こんにちは',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      failedTools: [],
      agentWarnings: [],
    };
    const message = toAssistantMessage(result, 1);
    expect(message).not.toHaveProperty('failedTools');
    expect(message).not.toHaveProperty('agentWarnings');
  });

  it('failedTools/agentWarnings に中身があるときはそのまま含める', () => {
    const result: ChatMessageResponseDto = {
      reply: 'こんにちは',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      failedTools: ['bd_create'],
      agentWarnings: ['warn1'],
    };
    const message = toAssistantMessage(result, 1);
    expect(message.failedTools).toEqual(['bd_create']);
    expect(message.agentWarnings).toEqual(['warn1']);
  });
});
