// bdboard-sso1.83: ChatPanel.tsx の「スレッド一覧ドロワーと行操作」まわりの状態を
// 1つの useReducer に畳んだもの。元は下記6個の独立した useState + 1個の
// useEffect だった:
//   threadDrawerOpen / threadActionMenuSessionId / renamingSessionId /
//   renameDraft / confirmingDeleteSessionId / showDiscoveredSessions
// これらは送受信・添付・会話キー再割り当て(bdboard-c1pw の対象)とは独立した
// 「今どの行が何の操作中か」を表す UI 状態で、bdboard-c1pw の調査でも
// 「既に独立していて事故っていない」グループとして触らない対象に挙げられていた
// (bdboard-c1pw 本文参照)。ここではそのグループだけを対象に、素朴な
// setState の組み合わせ呼び出しを明示的な action へ置き換える。挙動は変えない —
// 各 action は ChatPanel.tsx 側の元の setter 呼び出し(の組み合わせ)と
// 1対1で対応する。対応表は各 action のコメントを参照。
export interface ThreadDrawerState {
  drawerOpen: boolean;
  menuSessionId: string | null;
  renamingSessionId: string | null;
  renameDraft: string;
  confirmingDeleteSessionId: string | null;
  showDiscoveredSessions: boolean;
}

export const initialThreadDrawerState: ThreadDrawerState = {
  drawerOpen: false,
  menuSessionId: null,
  renamingSessionId: null,
  renameDraft: '',
  confirmingDeleteSessionId: null,
  showDiscoveredSessions: false,
};

export type ThreadDrawerAction =
  // 旧: onToggleDrawer={() => setThreadDrawerOpen((prev) => !prev)}
  | { type: 'toggleDrawer' }
  // 旧: onEscape/onClose/onNewThread/onResumeDiscoveredSession/
  // renderThreadDrawerClosedRow の各 setThreadDrawerOpen(false)
  | { type: 'closeDrawer' }
  // 旧: renderThreadDrawerOpenRow の行選択 onClick が行っていた
  // setConfirmingDeleteSessionId(null) + setRenamingSessionId(null) +
  // setThreadActionMenuSessionId(null) + setThreadDrawerOpen(false) の組み合わせ
  | { type: 'selectThread' }
  // 旧: setThreadActionMenuSessionId((prev) => (prev === sessionId ? null : sessionId))
  | { type: 'toggleMenu'; sessionId: string }
  // 旧: メニュー内のピン留め/タブから閉じるボタンの setThreadActionMenuSessionId(null)
  | { type: 'closeMenu' }
  // 旧: メニュー内のリネームボタンが行っていた setThreadActionMenuSessionId(null) +
  // setConfirmingDeleteSessionId(null) + setRenamingSessionId(sessionId) +
  // setRenameDraft(thread?.title ?? '') の組み合わせ
  | { type: 'startRename'; sessionId: string; initialDraft: string }
  // 旧: rename input の onChange
  | { type: 'changeRenameDraft'; text: string }
  // 旧: rename input の Escape、handleRenameConfirm の finally
  | { type: 'cancelRename' }
  // 旧: メニュー内の削除ボタン(1回目クリック、メニューは開いたまま) setConfirmingDeleteSessionId(sessionId)
  | { type: 'startConfirmDelete'; sessionId: string }
  // 旧: handleResumeDiscoveredSession / handleDeleteThread の finally /
  // startNewDraftThread が行っていた無条件の setConfirmingDeleteSessionId(null)
  | { type: 'cancelConfirmDelete' }
  // 旧: handleCloseThread が行っていた「対象 sessionId の
  // confirmingDeleteSessionId/renamingSessionId だけを条件付きで null に戻す」処理
  | { type: 'cancelInteractionsForSession'; sessionId: string }
  // 旧: onToggleDiscoveredSessions={() => setShowDiscoveredSessions((prev) => !prev)}
  | { type: 'toggleDiscoveredSessions' }
  // 旧: onCloseDiscoveredSessions={() => setShowDiscoveredSessions(false)}
  | { type: 'closeDiscoveredSessions' };

export function threadDrawerReducer(
  state: ThreadDrawerState,
  action: ThreadDrawerAction,
): ThreadDrawerState {
  switch (action.type) {
    case 'toggleDrawer': {
      const drawerOpen = !state.drawerOpen;
      if (drawerOpen) {
        return { ...state, drawerOpen };
      }
      // bdboard-f1c9: 旧実装は「threadDrawerOpen が false になったら
      // threadActionMenuSessionId も null に戻す」useEffect を別に持っていた
      // (ドロワーを閉じたのに行メニューだけ開いたままになる事故の防止)。
      // ここでは closeDrawer と同じ遷移として1箇所に畳み込む。
      return { ...state, drawerOpen: false, menuSessionId: null };
    }
    case 'closeDrawer':
      if (!state.drawerOpen && state.menuSessionId === null) {
        return state;
      }
      return { ...state, drawerOpen: false, menuSessionId: null };
    case 'selectThread':
      if (
        !state.drawerOpen &&
        state.menuSessionId === null &&
        state.renamingSessionId === null &&
        state.confirmingDeleteSessionId === null
      ) {
        return state;
      }
      return {
        ...state,
        drawerOpen: false,
        menuSessionId: null,
        renamingSessionId: null,
        confirmingDeleteSessionId: null,
      };
    case 'toggleMenu': {
      const menuSessionId = state.menuSessionId === action.sessionId ? null : action.sessionId;
      return { ...state, menuSessionId };
    }
    case 'closeMenu':
      if (state.menuSessionId === null) {
        return state;
      }
      return { ...state, menuSessionId: null };
    case 'startRename':
      return {
        ...state,
        menuSessionId: null,
        confirmingDeleteSessionId: null,
        renamingSessionId: action.sessionId,
        renameDraft: action.initialDraft,
      };
    case 'changeRenameDraft':
      return { ...state, renameDraft: action.text };
    case 'cancelRename':
      if (state.renamingSessionId === null) {
        return state;
      }
      return { ...state, renamingSessionId: null };
    case 'startConfirmDelete':
      return { ...state, confirmingDeleteSessionId: action.sessionId };
    case 'cancelConfirmDelete':
      if (state.confirmingDeleteSessionId === null) {
        return state;
      }
      return { ...state, confirmingDeleteSessionId: null };
    case 'cancelInteractionsForSession': {
      const clearConfirmingDelete = state.confirmingDeleteSessionId === action.sessionId;
      const clearRenaming = state.renamingSessionId === action.sessionId;
      if (!clearConfirmingDelete && !clearRenaming) {
        return state;
      }
      return {
        ...state,
        confirmingDeleteSessionId: clearConfirmingDelete ? null : state.confirmingDeleteSessionId,
        renamingSessionId: clearRenaming ? null : state.renamingSessionId,
      };
    }
    case 'toggleDiscoveredSessions':
      return { ...state, showDiscoveredSessions: !state.showDiscoveredSessions };
    case 'closeDiscoveredSessions':
      if (!state.showDiscoveredSessions) {
        return state;
      }
      return { ...state, showDiscoveredSessions: false };
    default:
      return state;
  }
}
