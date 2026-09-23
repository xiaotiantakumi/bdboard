import { useCallback, useEffect, useState } from 'react';

export interface AppChatContext {
  projectId: string;
  ticketId: string;
}

export interface AppOverlaysState {
  detailMaximized: boolean;
  handleToggleDetailMaximized: () => void;

  searchOpen: boolean;
  handleOpenSearch: () => void;
  handleCloseSearch: () => void;

  shortcutsOpen: boolean;
  handleOpenShortcuts: () => void;
  handleCloseShortcuts: () => void;

  helpOpen: boolean;
  handleOpenHelp: () => void;
  handleCloseHelp: () => void;

  chatOpen: boolean;
  chatContext: AppChatContext | undefined;
  chatContextToken: number;
  handleOpenChat: () => void;
  handleCloseChat: () => void;
  handleChatAboutTicket: (context: AppChatContext) => void;

  sessionListOpen: boolean;
  sessionListProjectId: string | undefined;
  handleOpenSessionList: (projectId?: string) => void;
  handleCloseSessionList: () => void;

  tunnelModalOpen: boolean;
  handleOpenTunnel: () => void;
  handleCloseTunnel: () => void;

  statusDetailOpen: boolean;
  setStatusDetailOpen: (open: boolean) => void;
  handleOpenStatusDetail: () => void;

  presetSaveIntentToken: number;
  handleSaveProjectCombination: () => void;
}

/**
 * App.tsx のオーバーレイ/パネル開閉状態(検索・ショートカット一覧・ヘルプ・
 * チャット・セッション一覧・トンネル・ステータス詳細・プリセット保存意図
 * トークン・詳細パネル最大化)をひとまとめにするフック(bdboard-62p4 第4段)。
 *
 * hook 呼び出し順について: 元の App.tsx では detailMaximized の
 * useState+useEffect (旧 L191-199) が先頭、続けて search/shortcuts/help/chat/
 * sessionList/tunnel/statusDetail/presetSaveIntentToken の useState 群
 * (旧 L200-214) が並んでいた。このフックは App.tsx 内の同じ位置
 * (useTicketDeepLink の直後、データ取得9系統より前)から1回だけ呼ぶため、
 * 内部のuseState群とdetailMaximizedのuseEffectは全体で見ても元と同じ相対
 * 位置・同じ順序で登録される。
 *
 * 各 open/close ハンドラ (handleOpenSessionList 等) は、元の App.tsx では
 * もっと後ろ (旧 L408-440、handleRefresh/handleToggleProject などの並び) で
 * useCallback として定義されていた。ここへまとめて前倒ししているが、これら
 * はいずれも自分自身の setState 以外に依存しない副作用のない
 * useCallback (useEffect ではない) なので、他の hook との実行順に依存する
 * 観測可能な挙動は無い — 純粋な値の計算がどの位置で行われるかは効果に
 * 影響しない(useEffect の実行順のみが厳密に保たれるべき対象)。
 *
 * handleOpenChat/handleCloseChat/handleChatAboutTicket/handleOpenTunnel/
 * handleCloseTunnel/handleOpenStatusDetail/handleSaveProjectCombination は、
 * 元の App.tsx では JSX 内のインライン無名関数 (`() => setChatOpen(true)` 等)
 * だった。ここで useCallback 化したことで参照が安定するが、呼び出したときの
 * 実行内容(何の setState を何の引数で呼ぶか)は一切変えていない。
 */
export function useAppOverlays(selectedTicketId: string | null): AppOverlaysState {
  const [detailMaximized, setDetailMaximized] = useState(false);
  const handleToggleDetailMaximized = useCallback(() => {
    setDetailMaximized((maximized) => !maximized);
  }, []);
  useEffect(() => {
    if (selectedTicketId === null) {
      setDetailMaximized(false);
    }
  }, [selectedTicketId]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatContext, setChatContext] = useState<AppChatContext | undefined>(undefined);
  const [chatContextToken, setChatContextToken] = useState(0);
  const [sessionListOpen, setSessionListOpen] = useState(false);
  const [sessionListProjectId, setSessionListProjectId] = useState<string | undefined>(
    undefined,
  );
  const [tunnelModalOpen, setTunnelModalOpen] = useState(false);
  const [statusDetailOpen, setStatusDetailOpen] = useState(false);
  const [presetSaveIntentToken, setPresetSaveIntentToken] = useState(0);

  const handleOpenSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);
  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);

  const handleOpenShortcuts = useCallback(() => {
    setShortcutsOpen(true);
  }, []);
  const handleCloseShortcuts = useCallback(() => {
    setShortcutsOpen(false);
  }, []);

  const handleOpenHelp = useCallback(() => {
    setHelpOpen(true);
  }, []);
  const handleCloseHelp = useCallback(() => {
    setHelpOpen(false);
  }, []);

  const handleOpenChat = useCallback(() => {
    setChatOpen(true);
  }, []);
  const handleCloseChat = useCallback(() => {
    setChatOpen(false);
    setChatContext(undefined);
  }, []);
  const handleChatAboutTicket = useCallback((context: AppChatContext) => {
    setChatContext(context);
    setChatContextToken((token) => token + 1);
    setChatOpen(true);
  }, []);

  const handleOpenSessionList = useCallback((projectId?: string) => {
    setSessionListProjectId(projectId);
    setSessionListOpen(true);
  }, []);
  const handleCloseSessionList = useCallback(() => {
    setSessionListOpen(false);
    setSessionListProjectId(undefined);
  }, []);

  const handleOpenTunnel = useCallback(() => {
    setTunnelModalOpen(true);
  }, []);
  const handleCloseTunnel = useCallback(() => {
    setTunnelModalOpen(false);
  }, []);

  const handleOpenStatusDetail = useCallback(() => {
    setStatusDetailOpen(true);
  }, []);

  const handleSaveProjectCombination = useCallback(() => {
    setPresetSaveIntentToken((token) => token + 1);
  }, []);

  return {
    detailMaximized,
    handleToggleDetailMaximized,

    searchOpen,
    handleOpenSearch,
    handleCloseSearch,

    shortcutsOpen,
    handleOpenShortcuts,
    handleCloseShortcuts,

    helpOpen,
    handleOpenHelp,
    handleCloseHelp,

    chatOpen,
    chatContext,
    chatContextToken,
    handleOpenChat,
    handleCloseChat,
    handleChatAboutTicket,

    sessionListOpen,
    sessionListProjectId,
    handleOpenSessionList,
    handleCloseSessionList,

    tunnelModalOpen,
    handleOpenTunnel,
    handleCloseTunnel,

    statusDetailOpen,
    setStatusDetailOpen,
    handleOpenStatusDetail,

    presetSaveIntentToken,
    handleSaveProjectCombination,
  };
}
