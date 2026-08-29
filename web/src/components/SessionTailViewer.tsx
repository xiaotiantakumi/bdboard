import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import {
  ApiError,
  fetchSessionTail,
  type SessionTailMessageDto,
} from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useHistoryBackClose } from '../hooks/useHistoryBackClose';
import {
  SidePanelResizeHandle,
  useResizableSidePanel,
} from '../hooks/useResizableSidePanel';
import { formatAbsoluteTime } from '../formatAbsoluteTime';
import { UI_STORAGE_KEYS } from '../uiPersistedState';

interface SessionTailViewerProps {
  sessionId: string;
  sessionLabel?: string;
  onClose: () => void;
}

function roleLabel(role: SessionTailMessageDto['role']): string {
  return role === 'user' ? 'ユーザー' : 'アシスタント';
}

export function SessionTailViewer({
  sessionId,
  sessionLabel,
  onClose,
}: SessionTailViewerProps) {
  const sessionTailPanel = useResizableSidePanel(
    UI_STORAGE_KEYS.sessionTailPanelWidth,
  );
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const { requestClose } = useHistoryBackClose({
    panelId: `session-tail-${sessionId}`,
    onClose,
  });

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: requestClose,
  });

  const tailQuery = useQuery({
    queryKey: ['sessionTail', sessionId],
    queryFn: () => fetchSessionTail(sessionId),
    refetchInterval: 5000,
  });

  const title =
    sessionLabel !== undefined
      ? `トランスクリプト — ${sessionLabel}`
      : `トランスクリプト — ${sessionId}`;

  const messages = tailQuery.data?.messages ?? [];
  const isLoading = tailQuery.isLoading;
  const error = tailQuery.error;

  return (
    <div className="overlay" onClick={requestClose} role="presentation">
      <aside
        ref={panelRef}
        className={`detail-panel session-tail-panel resizable-side-panel${sessionTailPanel.isResizing ? ' is-resizing' : ''}`}
        style={{ width: `${sessionTailPanel.width}px` }}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-tail-title"
      >
        <SidePanelResizeHandle
          label="トランスクリプトパネルの幅を変更"
          panel={sessionTailPanel}
        />
        <div className="detail-header">
          <h2 id="session-tail-title" className="detail-title">
            {title}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn detail-close"
            onClick={requestClose}
          >
            閉じる
          </button>
        </div>

        <p className="session-tail-note">
          直近の user / assistant テキストのみ表示しています（5秒ごとに更新）。
        </p>

        {isLoading && <p className="loading">読み込み中…</p>}
        {error !== null && (
          <p className="error-message">
            {error instanceof ApiError
              ? error.message
              : error instanceof Error
                ? error.message
                : '読み込みに失敗しました'}
          </p>
        )}

        {!isLoading && error === null && messages.length === 0 && (
          <p className="empty-message">表示できるメッセージがありません</p>
        )}

        {!isLoading && error === null && messages.length > 0 && (
          <ul className="session-tail-messages">
            {messages.map((message, index) => (
              <li
                key={`${message.role}-${index}-${message.timestamp ?? 'no-ts'}`}
                className={`session-tail-message session-tail-message-${message.role}`}
              >
                <div className="session-tail-message-header">
                  <span className="session-tail-role">{roleLabel(message.role)}</span>
                  {message.timestamp !== undefined && (
                    <span className="session-tail-timestamp">
                      {formatAbsoluteTime(message.timestamp)}
                    </span>
                  )}
                </div>
                <pre className="session-tail-text">{message.text}</pre>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
