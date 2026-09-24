import { isImeComposingKeyEvent } from '../../imeGuard';
import type { ChatThreadDto } from '../../api';
import { formatThreadUpdatedAt } from './threads';

/**
 * bdboard-sso1.83 第6段: 開いている/ピン留めスレッドの行(リネーム入力・「⋯」操作
 * メニュー・削除確認の2段階を含む)と、閉じたスレッドの行の両方から使う操作の束。
 * ハンドラ本体は ChatPanel.tsx に残り、ここには関数として渡すだけ
 * (togglePin/closeThread は元実装どおりメニューを閉じる処理を内包している)。
 */
export interface ThreadDrawerRowActions {
  select: (sessionId: string) => void;
  reopenClosed: (sessionId: string) => void;
  changeRenameDraft: (text: string) => void;
  confirmRename: (sessionId: string) => void;
  cancelRename: () => void;
  toggleMenu: (sessionId: string) => void;
  startRename: (sessionId: string, initialDraft: string) => void;
  /** メニューを閉じたうえでピン留め状態を切り替える(元実装の closeThreadActionMenu 呼び出しを含む)。 */
  togglePin: (sessionId: string, pinned: boolean) => void;
  /** メニューを閉じたうえでタブから閉じる(元実装の closeThreadActionMenu 呼び出しを含む)。 */
  closeThread: (sessionId: string) => void;
  startConfirmDelete: (sessionId: string) => void;
  deleteThread: (sessionId: string) => void;
}

interface ChatThreadDrawerOpenRowProps {
  sessionId: string;
  thread?: ChatThreadDto;
  agentLabel?: string;
  isSelected: boolean;
  isRenaming: boolean;
  renameDraft: string;
  isMenuOpen: boolean;
  isConfirmingDelete: boolean;
  actions: ThreadDrawerRowActions;
}

/**
 * bdboard-sso1.83 第6段: ChatPanel.tsx の renderThreadDrawerOpenRow を move-only で
 * 移した、状態を持たない表示コンポーネント。state・ハンドラ本体・永続化呼び出しは
 * すべて ChatPanel 側(useThreadDrawerState 他)に残り、actions 経由で渡す。
 * 見た目・aria-label・class 名は一切変えていない(key は呼び出し側の .map() が
 * コンポーネント要素自体に付けるので、このファイル内では持たない)。
 */
export function ChatThreadDrawerOpenRow({
  sessionId,
  thread,
  agentLabel,
  isSelected,
  isRenaming,
  renameDraft,
  isMenuOpen,
  isConfirmingDelete,
  actions,
}: ChatThreadDrawerOpenRowProps) {
  const threadTitle = thread?.title ?? '(無題)';
  const isPinned = thread?.pinned ?? false;
  const metaParts = [
    thread !== undefined ? formatThreadUpdatedAt(thread.updatedAt) : undefined,
    agentLabel,
  ].filter((part): part is string => part !== undefined && part !== '');

  return (
    <div className={`chat-thread-drawer-item${isSelected ? ' is-selected' : ''}`}>
      {isRenaming ? (
        <input
          className="chat-thread-rename-input"
          type="text"
          aria-label={`スレッド「${threadTitle}」の新しいタイトル`}
          value={renameDraft}
          autoFocus
          onChange={(event) => actions.changeRenameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              if (isImeComposingKeyEvent(event)) {
                return;
              }
              event.preventDefault();
              actions.confirmRename(sessionId);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              actions.cancelRename();
            }
          }}
          onBlur={() => actions.confirmRename(sessionId)}
        />
      ) : (
        <button
          type="button"
          className="chat-thread-drawer-item-select"
          aria-current={isSelected ? 'true' : undefined}
          onClick={() => actions.select(sessionId)}
        >
          {isPinned && (
            <span className="chat-thread-drawer-item-pin" aria-hidden="true">
              📌
            </span>
          )}
          <span className="chat-thread-drawer-item-title">{threadTitle}</span>
          {metaParts.length > 0 && (
            <span className="chat-thread-drawer-item-meta" aria-hidden="true">
              {metaParts.join(' · ')}
            </span>
          )}
        </button>
      )}
      <div className="chat-thread-drawer-item-menu-wrap">
        <button
          type="button"
          className="chat-thread-drawer-item-menu-toggle"
          aria-label={`スレッド「${threadTitle}」の操作`}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          onClick={() => actions.toggleMenu(sessionId)}
        >
          ⋯
        </button>
        {isMenuOpen && (
          <div
            className="chat-thread-drawer-item-menu"
            role="menu"
            aria-label={`スレッド「${threadTitle}」の操作メニュー`}
          >
            <button
              type="button"
              role="menuitem"
              className="chat-thread-drawer-menu-item"
              onClick={() => actions.startRename(sessionId, thread?.title ?? '')}
            >
              リネーム
            </button>
            <button
              type="button"
              role="menuitem"
              className="chat-thread-drawer-menu-item"
              onClick={() => actions.togglePin(sessionId, isPinned)}
            >
              {isPinned ? 'ピン留め解除' : 'ピン留め'}
            </button>
            <button
              type="button"
              role="menuitem"
              className="chat-thread-drawer-menu-item"
              onClick={() => actions.closeThread(sessionId)}
            >
              タブから閉じる
              <span className="chat-thread-drawer-item-menu-hint">
                履歴は残る。「閉じたスレッド」から戻せる
              </span>
            </button>
            <div className="chat-thread-drawer-item-menu-divider" />
            {isConfirmingDelete ? (
              <button
                type="button"
                role="menuitem"
                className="chat-thread-drawer-menu-item chat-thread-drawer-menu-item-danger"
                onClick={() => actions.deleteThread(sessionId)}
              >
                <span className="chat-thread-delete-icon" aria-hidden="true">
                  🗑
                </span>
                本当に削除
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                className="chat-thread-drawer-menu-item chat-thread-drawer-menu-item-danger"
                onClick={() => actions.startConfirmDelete(sessionId)}
              >
                <span className="chat-thread-delete-icon" aria-hidden="true">
                  🗑
                </span>
                削除
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
