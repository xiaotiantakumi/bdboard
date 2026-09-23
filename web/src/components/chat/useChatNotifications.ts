import { useCallback, useReducer } from 'react';
import {
  chatNotificationsReducer,
  initialChatNotificationsState,
  type ChatNotificationsState,
} from './chatNotificationsState';

export interface UseChatNotificationsResult extends ChatNotificationsState {
  setThreadError: (message: string | null) => void;
  setTicketProjectFallbackNotice: (message: string | null) => void;
}

/**
 * bdboard-sso1.83 第3段: ChatPanel.tsx から「エラー・通知」表示 state
 * (threadError / ticketProjectFallbackNotice) の配線を抜き出したもの。状態遷移は
 * chatNotificationsState.ts の reducer が持つ。ここは useReducer を包んで、
 * 呼び出し側(ChatPanel)が元の setState 呼び出しと1対1で置き換えられる粒度の
 * 安定した setter を返すだけの薄い層(useThreadDrawerState.ts と同じパターン)。
 * setter は useCallback で包み、呼び出し側の useCallback 依存配列に安全に
 * 乗せられるようにしている。
 */
export function useChatNotifications(): UseChatNotificationsResult {
  const [state, dispatch] = useReducer(
    chatNotificationsReducer,
    initialChatNotificationsState,
  );

  const setThreadError = useCallback(
    (message: string | null) => dispatch({ type: 'setThreadError', message }),
    [],
  );
  const setTicketProjectFallbackNotice = useCallback(
    (message: string | null) =>
      dispatch({ type: 'setTicketProjectFallbackNotice', message }),
    [],
  );

  return {
    ...state,
    setThreadError,
    setTicketProjectFallbackNotice,
  };
}
