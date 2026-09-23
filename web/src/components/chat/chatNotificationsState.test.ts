import { describe, expect, it } from 'vitest';
import {
  chatNotificationsReducer,
  initialChatNotificationsState,
  type ChatNotificationsState,
} from './chatNotificationsState';

describe('chatNotificationsReducer (bdboard-sso1.83 第3段)', () => {
  it('starts with no thread error and no ticket fallback notice', () => {
    expect(initialChatNotificationsState).toEqual({
      threadError: null,
      ticketProjectFallbackNotice: null,
    });
  });

  describe('setThreadError', () => {
    it('sets a message (旧: setThreadError("...失敗しました。"))', () => {
      const next = chatNotificationsReducer(initialChatNotificationsState, {
        type: 'setThreadError',
        message: 'スレッド一覧の取得に失敗しました。',
      });
      expect(next.threadError).toBe('スレッド一覧の取得に失敗しました。');
    });

    it('clears a message (旧: setThreadError(null))', () => {
      const withError: ChatNotificationsState = {
        ...initialChatNotificationsState,
        threadError: 'スレッドの削除に失敗しました。',
      };
      const next = chatNotificationsReducer(withError, {
        type: 'setThreadError',
        message: null,
      });
      expect(next.threadError).toBeNull();
    });

    it('leaves ticketProjectFallbackNotice untouched', () => {
      const withNotice: ChatNotificationsState = {
        threadError: null,
        ticketProjectFallbackNotice: '通知文言',
      };
      const next = chatNotificationsReducer(withNotice, {
        type: 'setThreadError',
        message: 'スレッド名の変更に失敗しました。',
      });
      expect(next.ticketProjectFallbackNotice).toBe('通知文言');
    });

    it('returns the same state reference when the message does not change (React useState の Object.is bail-out と同じ挙動)', () => {
      const withError: ChatNotificationsState = {
        ...initialChatNotificationsState,
        threadError: 'ピン留めの変更に失敗しました。',
      };
      const next = chatNotificationsReducer(withError, {
        type: 'setThreadError',
        message: 'ピン留めの変更に失敗しました。',
      });
      expect(next).toBe(withError);
    });
  });

  describe('setTicketProjectFallbackNotice', () => {
    it('sets a message (旧: setTicketProjectFallbackNotice("...で開いています。..."))', () => {
      const next = chatNotificationsReducer(initialChatNotificationsState, {
        type: 'setTicketProjectFallbackNotice',
        message: 'チケットのプロジェクト(id: proj-1)が見つからないため、「fallback」で開いています。',
      });
      expect(next.ticketProjectFallbackNotice).toBe(
        'チケットのプロジェクト(id: proj-1)が見つからないため、「fallback」で開いています。',
      );
    });

    it('clears a message (旧: setTicketProjectFallbackNotice(null))', () => {
      const withNotice: ChatNotificationsState = {
        ...initialChatNotificationsState,
        ticketProjectFallbackNotice: '見つかりません。',
      };
      const next = chatNotificationsReducer(withNotice, {
        type: 'setTicketProjectFallbackNotice',
        message: null,
      });
      expect(next.ticketProjectFallbackNotice).toBeNull();
    });

    it('leaves threadError untouched', () => {
      const withError: ChatNotificationsState = {
        threadError: 'スレッド一覧の取得に失敗しました。',
        ticketProjectFallbackNotice: null,
      };
      const next = chatNotificationsReducer(withError, {
        type: 'setTicketProjectFallbackNotice',
        message: '利用可能になりました。',
      });
      expect(next.threadError).toBe('スレッド一覧の取得に失敗しました。');
    });

    it('returns the same state reference when the message does not change', () => {
      const withNotice: ChatNotificationsState = {
        ...initialChatNotificationsState,
        ticketProjectFallbackNotice: '利用可能になりました。',
      };
      const next = chatNotificationsReducer(withNotice, {
        type: 'setTicketProjectFallbackNotice',
        message: '利用可能になりました。',
      });
      expect(next).toBe(withNotice);
    });

    it('returns the same state reference for a repeated null clear', () => {
      const next = chatNotificationsReducer(initialChatNotificationsState, {
        type: 'setTicketProjectFallbackNotice',
        message: null,
      });
      expect(next).toBe(initialChatNotificationsState);
    });
  });
});
