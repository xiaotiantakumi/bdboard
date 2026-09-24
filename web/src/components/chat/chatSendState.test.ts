import { describe, expect, it } from 'vitest';
import {
  chatSendReducer,
  initialChatSendState,
  type ChatSendState,
} from './chatSendState';

describe('chatSendReducer (bdboard-sso1.83 第13a段)', () => {
  it('starts with empty send state', () => {
    expect(initialChatSendState).toEqual({
      isSending: false,
      streamingReply: {},
      turnRecoveryGeneration: 0,
      unresolvedSends: {},
    });
  });

  describe('set-is-sending', () => {
    it('sets the value and leaves the other slices untouched', () => {
      const next = chatSendReducer(initialChatSendState, { type: 'set-is-sending', value: true });
      expect(next.isSending).toBe(true);
      expect(next.streamingReply).toBe(initialChatSendState.streamingReply);
      expect(next.turnRecoveryGeneration).toBe(initialChatSendState.turnRecoveryGeneration);
      expect(next.unresolvedSends).toBe(initialChatSendState.unresolvedSends);
    });

    it('returns the same state when the value does not change', () => {
      expect(chatSendReducer(initialChatSendState, { type: 'set-is-sending', value: false })).toBe(
        initialChatSendState,
      );
    });
  });

  describe('replace-streaming-reply', () => {
    it('adds a key and supports delta appends', () => {
      const first = chatSendReducer(initialChatSendState, {
        type: 'replace-streaming-reply',
        updater: (prev) => ({ ...prev, send: 'hello' }),
      });
      const next = chatSendReducer(first, {
        type: 'replace-streaming-reply',
        updater: (prev) => ({ ...prev, send: `${prev.send} world` }),
      });
      expect(next.streamingReply).toEqual({ send: 'hello world' });
    });

    it('returns the same state for a no-op updater', () => {
      expect(
        chatSendReducer(initialChatSendState, {
          type: 'replace-streaming-reply',
          updater: (prev) => prev,
        }),
      ).toBe(initialChatSendState);
    });
  });

  describe('clear-streaming-reply-for-key', () => {
    const state: ChatSendState = { ...initialChatSendState, streamingReply: { keep: 'x', remove: 'y' } };

    it('removes only the requested key', () => {
      expect(chatSendReducer(state, { type: 'clear-streaming-reply-for-key', key: 'remove' }).streamingReply)
        .toEqual({ keep: 'x' });
    });

    it('returns the same state when the key is absent', () => {
      expect(chatSendReducer(state, { type: 'clear-streaming-reply-for-key', key: 'missing' })).toBe(state);
    });
  });

  describe('replace-turn-recovery-generation', () => {
    it('increments the generation', () => {
      expect(
        chatSendReducer(initialChatSendState, {
          type: 'replace-turn-recovery-generation',
          updater: (generation) => generation + 1,
        }).turnRecoveryGeneration,
      ).toBe(1);
    });

    it('returns the same state for a no-op updater', () => {
      expect(
        chatSendReducer(initialChatSendState, {
          type: 'replace-turn-recovery-generation',
          updater: (generation) => generation,
        }),
      ).toBe(initialChatSendState);
    });
  });

  describe('mark-unresolved-send', () => {
    it('adds a session ID', () => {
      expect(chatSendReducer(initialChatSendState, { type: 'mark-unresolved-send', sessionId: 's1' }).unresolvedSends)
        .toEqual({ s1: true });
    });

    it('returns the same state when the session ID is already marked', () => {
      const state: ChatSendState = { ...initialChatSendState, unresolvedSends: { s1: true } };
      expect(chatSendReducer(state, { type: 'mark-unresolved-send', sessionId: 's1' })).toBe(state);
    });
  });

  describe('clear-unresolved-send', () => {
    const state: ChatSendState = { ...initialChatSendState, unresolvedSends: { s1: true, s2: true } };

    it('removes the requested session ID', () => {
      expect(chatSendReducer(state, { type: 'clear-unresolved-send', sessionId: 's1' }).unresolvedSends)
        .toEqual({ s2: true });
    });

    it('returns the same state when the session ID is absent', () => {
      expect(chatSendReducer(state, { type: 'clear-unresolved-send', sessionId: 'missing' })).toBe(state);
    });
  });
});
