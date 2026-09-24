import type { ChatThreadDto } from '../../api';
import type { ThreadDrawerRowActions } from './ChatThreadDrawerOpenRow';

interface ChatThreadDrawerClosedRowProps {
  thread: ChatThreadDto;
  actions: Pick<ThreadDrawerRowActions, 'reopenClosed'>;
}

/**
 * bdboard-sso1.83 第6段: ChatPanel.tsx の renderThreadDrawerClosedRow を move-only で
 * 移した、状態を持たない表示コンポーネント。「開く」処理本体(openThreadIds/
 * selectedThreadIds の更新・永続化・ドロワーを閉じる)は ChatPanel 側に残り、
 * actions.reopenClosed 経由で渡す。見た目・class 名は一切変えていない(key は
 * 呼び出し側の .map() がコンポーネント要素自体に付ける)。
 */
export function ChatThreadDrawerClosedRow({ thread, actions }: ChatThreadDrawerClosedRowProps) {
  const threadTitle = thread.title ?? '(無題)';
  return (
    <button
      type="button"
      className="chat-thread-drawer-item chat-thread-drawer-item-closed"
      onClick={() => actions.reopenClosed(thread.sessionId)}
    >
      {thread.pinned && (
        <span className="chat-thread-drawer-item-pin" aria-hidden="true">
          📌
        </span>
      )}
      <span className="chat-thread-drawer-item-title">{threadTitle}</span>
    </button>
  );
}
