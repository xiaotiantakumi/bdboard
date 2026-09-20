import type { ReactNode, RefObject } from 'react';
import { DiscoveredSessionsPanel } from '../DiscoveredSessionsPanel';
import type { SessionTailMessageDto } from '../../api';

interface ChatThreadDrawerProps {
  open: boolean;
  drawerRef: RefObject<HTMLDivElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  hasPinnedRows: boolean;
  pinnedRows: ReactNode;
  hasOpenRows: boolean;
  openRows: ReactNode;
  hasVisibleClosedThreads: boolean;
  closedRows: ReactNode;
  selectedProjectId: string;
  showDiscoveredSessions: boolean;
  onToggleDiscoveredSessions: () => void;
  isSending: boolean;
  onCloseDiscoveredSessions: () => void;
  onResumeDiscoveredSession: (
    sessionId: string,
    agentId: string,
    seedMessages: SessionTailMessageDto[],
  ) => void;
}

/**
 * bdboard-sso1.2 (PR-B): ChatPanel.tsx から状態を持たない表示部分だけを移動したもの。
 * 開閉状態・フォーカストラップ用 ref・行データ(pinnedRows 等)はすべて呼び出し側
 * (ChatPanel) が state/useRef/useMemo で持ち続け、ここには props としてのみ渡す。
 */
export function ChatThreadDrawer({
  open,
  drawerRef,
  closeButtonRef,
  onClose,
  hasPinnedRows,
  pinnedRows,
  hasOpenRows,
  openRows,
  hasVisibleClosedThreads,
  closedRows,
  selectedProjectId,
  showDiscoveredSessions,
  onToggleDiscoveredSessions,
  isSending,
  onCloseDiscoveredSessions,
  onResumeDiscoveredSession,
}: ChatThreadDrawerProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="chat-thread-drawer-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={drawerRef}
        id="chat-thread-drawer"
        className="chat-thread-drawer"
        role="dialog"
        aria-label="スレッド一覧"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="chat-thread-drawer-header">
          <span className="chat-thread-drawer-title">スレッド</span>
          <button
            ref={closeButtonRef}
            type="button"
            className="chat-thread-drawer-close"
            onClick={onClose}
          >
            閉じる
          </button>
        </div>

        {hasPinnedRows && (
          <div className="chat-thread-drawer-section">
            <p className="chat-thread-drawer-section-title">ピン留め</p>
            {pinnedRows}
          </div>
        )}

        <div className="chat-thread-drawer-section">
          <p className="chat-thread-drawer-section-title">開いているスレッド</p>
          {hasOpenRows ? (
            openRows
          ) : (
            <p className="chat-thread-drawer-section-empty">
              他に開いているスレッドはありません。
            </p>
          )}
        </div>

        {hasVisibleClosedThreads && (
          <div className="chat-thread-drawer-section">
            <p className="chat-thread-drawer-section-title">閉じたスレッド</p>
            <p className="chat-thread-drawer-section-hint">
              履歴は残っています。選ぶと一覧の上に戻ります。
            </p>
            {closedRows}
          </div>
        )}

        {selectedProjectId !== '' && (
          <div className="chat-thread-drawer-section">
            <p className="chat-thread-drawer-section-title">
              bdboard 外で動いていた CLI セッション
            </p>
            <p className="chat-thread-drawer-section-hint">
              ターミナルの Claude Code の会話。選ぶと続きから話せます。
            </p>
            <button
              type="button"
              className="btn chat-discovered-sessions-toggle"
              onClick={onToggleDiscoveredSessions}
              disabled={isSending}
            >
              CLIセッションを再開
            </button>
            {showDiscoveredSessions && (
              <DiscoveredSessionsPanel
                projectId={selectedProjectId}
                onClose={onCloseDiscoveredSessions}
                onResume={onResumeDiscoveredSession}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
