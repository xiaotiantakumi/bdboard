import { useCallback, useReducer } from 'react';
import {
  initialThreadDrawerState,
  threadDrawerReducer,
  type ThreadDrawerState,
} from './threadDrawerState';

export interface ThreadDrawerActions {
  toggleDrawer: () => void;
  closeDrawer: () => void;
  selectThread: () => void;
  toggleMenu: (sessionId: string) => void;
  closeMenu: () => void;
  startRename: (sessionId: string, initialDraft: string) => void;
  changeRenameDraft: (text: string) => void;
  cancelRename: () => void;
  startConfirmDelete: (sessionId: string) => void;
  cancelConfirmDelete: () => void;
  cancelInteractionsForSession: (sessionId: string) => void;
  toggleDiscoveredSessions: () => void;
  closeDiscoveredSessions: () => void;
}

export interface UseThreadDrawerStateResult extends ThreadDrawerActions {
  state: ThreadDrawerState;
}

/**
 * bdboard-sso1.83: ChatPanel.tsx から「スレッド一覧ドロワーと行操作」の状態配線を
 * 抜き出したもの。中身の状態遷移は threadDrawerState.ts の reducer が持つ。
 * ここは useReducer を包んで、呼び出し側(ChatPanel)が元の setter 呼び出しと
 * 1対1で置き換えられる粒度の安定した関数を返すだけの薄い層。
 * dispatch 自体は React が安定性を保証するが、返す各関数は useCallback で包み、
 * 呼び出し側の useCallback 依存配列に安全に乗せられるようにしている
 * (このコンポーネントの他の setState ラッパー — clearStreamingReplyForKey 等 — と
 * 同じパターン)。
 */
export function useThreadDrawerState(): UseThreadDrawerStateResult {
  const [state, dispatch] = useReducer(threadDrawerReducer, initialThreadDrawerState);

  const toggleDrawer = useCallback(() => dispatch({ type: 'toggleDrawer' }), []);
  const closeDrawer = useCallback(() => dispatch({ type: 'closeDrawer' }), []);
  const selectThread = useCallback(() => dispatch({ type: 'selectThread' }), []);
  const toggleMenu = useCallback(
    (sessionId: string) => dispatch({ type: 'toggleMenu', sessionId }),
    [],
  );
  const closeMenu = useCallback(() => dispatch({ type: 'closeMenu' }), []);
  const startRename = useCallback(
    (sessionId: string, initialDraft: string) =>
      dispatch({ type: 'startRename', sessionId, initialDraft }),
    [],
  );
  const changeRenameDraft = useCallback(
    (text: string) => dispatch({ type: 'changeRenameDraft', text }),
    [],
  );
  const cancelRename = useCallback(() => dispatch({ type: 'cancelRename' }), []);
  const startConfirmDelete = useCallback(
    (sessionId: string) => dispatch({ type: 'startConfirmDelete', sessionId }),
    [],
  );
  const cancelConfirmDelete = useCallback(() => dispatch({ type: 'cancelConfirmDelete' }), []);
  const cancelInteractionsForSession = useCallback(
    (sessionId: string) => dispatch({ type: 'cancelInteractionsForSession', sessionId }),
    [],
  );
  const toggleDiscoveredSessions = useCallback(
    () => dispatch({ type: 'toggleDiscoveredSessions' }),
    [],
  );
  const closeDiscoveredSessions = useCallback(
    () => dispatch({ type: 'closeDiscoveredSessions' }),
    [],
  );

  return {
    state,
    toggleDrawer,
    closeDrawer,
    selectThread,
    toggleMenu,
    closeMenu,
    startRename,
    changeRenameDraft,
    cancelRename,
    startConfirmDelete,
    cancelConfirmDelete,
    cancelInteractionsForSession,
    toggleDiscoveredSessions,
    closeDiscoveredSessions,
  };
}
