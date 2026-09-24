import { describe, expect, it } from 'vitest';
import type { ChatAttachment } from './attachments';
import {
  attachmentsSlice,
  chatDraftReducer,
  createInitialChatDraftState,
  type ChatDraftState,
} from './chatDraftState';

function attachment(id: string): ChatAttachment {
  return {
    id,
    file: new File(['x'], `${id}.png`, { type: 'image/png' }),
    mimeType: 'image/png',
    previewUrl: `data:image/png;base64,${id}`,
    name: `${id}.png`,
    size: 1,
  };
}

const emptyState: ChatDraftState = createInitialChatDraftState({});

describe('createInitialChatDraftState (bdboard-sso1.83 第2段)', () => {
  it('seeds conversationInputs from the given record and starts attachments/errors empty', () => {
    const seed = { 'new::0': 'hello' };
    const state = createInitialChatDraftState(seed);
    expect(state).toEqual({
      conversationInputs: { 'new::0': 'hello' },
      conversationAttachments: {},
      attachmentErrors: {},
    });
  });
});

describe('chatDraftReducer', () => {
  describe('set-input (旧: textarea onChange / handleQuickCommand)', () => {
    it('writes the value for the given key without touching other keys', () => {
      const state: ChatDraftState = {
        ...emptyState,
        conversationInputs: { a: '既存' },
      };
      const next = chatDraftReducer(state, { type: 'set-input', key: 'b', value: '新規' });
      expect(next.conversationInputs).toEqual({ a: '既存', b: '新規' });
      // 他の2ストアは触らない
      expect(next.conversationAttachments).toBe(state.conversationAttachments);
      expect(next.attachmentErrors).toBe(state.attachmentErrors);
    });
  });

  describe('replace-inputs (旧: startNewDraftThread 等の setConversationInputs(updater))', () => {
    it('applies the given updater to the whole record', () => {
      const state: ChatDraftState = { ...emptyState, conversationInputs: { a: '1' } };
      const next = chatDraftReducer(state, {
        type: 'replace-inputs',
        updater: (prev) => ({ ...prev, b: '2' }),
      });
      expect(next.conversationInputs).toEqual({ a: '1', b: '2' });
    });
  });

  describe('add-attachments (旧: ingestImageFiles 成功時の追記+該当エラー削除)', () => {
    it('appends attachments for the key and atomically clears that key error', () => {
      const state: ChatDraftState = {
        ...emptyState,
        conversationAttachments: { k: [attachment('1')] },
        attachmentErrors: { k: '前回のエラー', other: '無関係' },
      };
      const next = chatDraftReducer(state, {
        type: 'add-attachments',
        key: 'k',
        items: [attachment('2')],
      });
      expect(next.conversationAttachments.k.map((a) => a.id)).toEqual(['1', '2']);
      expect(next.attachmentErrors).toEqual({ other: '無関係' });
    });

    it('starts a fresh list when the key had no attachments yet', () => {
      const next = chatDraftReducer(emptyState, {
        type: 'add-attachments',
        key: 'k',
        items: [attachment('1')],
      });
      expect(next.conversationAttachments.k.map((a) => a.id)).toEqual(['1']);
    });
  });

  describe('remove-attachment (旧: removeAttachment の除外+該当エラー削除)', () => {
    it('filters out the given id and atomically clears that key error', () => {
      const state: ChatDraftState = {
        ...emptyState,
        conversationAttachments: { k: [attachment('1'), attachment('2')] },
        attachmentErrors: { k: 'エラー' },
      };
      const next = chatDraftReducer(state, { type: 'remove-attachment', key: 'k', id: '1' });
      expect(next.conversationAttachments.k.map((a) => a.id)).toEqual(['2']);
      expect(next.attachmentErrors).toEqual({});
    });
  });

  describe('replace-attachments (旧: updateConversationAttachments(updater))', () => {
    it('applies the given updater to the whole record', () => {
      const state: ChatDraftState = {
        ...emptyState,
        conversationAttachments: { a: [attachment('1')] },
      };
      const next = chatDraftReducer(state, {
        type: 'replace-attachments',
        updater: (prev) => {
          const { a: moved, ...rest } = prev;
          return { ...rest, b: moved };
        },
      });
      expect(next.conversationAttachments).toEqual({ b: [attachment('1')] });
    });
  });

  describe('set-attachment-error (旧: setAttachmentErrors({...prev, [key]: message}))', () => {
    it('sets the message for the key without touching other keys', () => {
      const state: ChatDraftState = { ...emptyState, attachmentErrors: { other: '既存' } };
      const next = chatDraftReducer(state, {
        type: 'set-attachment-error',
        key: 'k',
        message: '失敗しました',
      });
      expect(next.attachmentErrors).toEqual({ other: '既存', k: '失敗しました' });
    });
  });

  describe('clear-attachment-error (旧: setAttachmentErrors の該当キー削除)', () => {
    it('removes the error for the key', () => {
      const state: ChatDraftState = { ...emptyState, attachmentErrors: { k: 'エラー' } };
      const next = chatDraftReducer(state, { type: 'clear-attachment-error', key: 'k' });
      expect(next.attachmentErrors).toEqual({});
    });

    it('is a no-op (same reference for that slice) when the key has no error', () => {
      const state: ChatDraftState = { ...emptyState, attachmentErrors: { other: 'エラー' } };
      const next = chatDraftReducer(state, { type: 'clear-attachment-error', key: 'missing' });
      expect(next.attachmentErrors).toBe(state.attachmentErrors);
    });
  });

  describe('replace-attachment-errors (旧: draftApplicators の migrate/purge 経由 updater)', () => {
    it('applies the given updater to the whole record', () => {
      const state: ChatDraftState = { ...emptyState, attachmentErrors: { a: '1' } };
      const next = chatDraftReducer(state, {
        type: 'replace-attachment-errors',
        updater: (prev) => ({ ...prev, b: '2' }),
      });
      expect(next.attachmentErrors).toEqual({ a: '1', b: '2' });
    });
  });
});

describe('attachmentsSlice (useChatAttachmentIngestion の eager sync が直接呼ぶ純粋関数)', () => {
  it('is exported and matches chatDraftReducer for add-attachments', () => {
    const action = { type: 'add-attachments' as const, key: 'k', items: [attachment('1')] };
    expect(attachmentsSlice({}, action)).toEqual(chatDraftReducer(emptyState, action).conversationAttachments);
  });
});
