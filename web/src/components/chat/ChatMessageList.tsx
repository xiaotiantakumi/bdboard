import type { RefObject } from 'react';
import type { ChatTurnStatusDto } from '../../api';
import { ChatMessageRow } from './ChatMessageRow';
import type { ChatMessage } from './messages';

/**
 * チャットのメッセージログ本体(バックグラウンド処理中バナー・メッセージ行・
 * ストリーミング中テキスト・「考え中…」表示)。
 *
 * bdboard-sso1.2 PR-E: ChatPanel.tsx から状態を持たない表示部分を抜き出す
 * 段階的分割の一環。`messagesRef` は ChatPanel.tsx の useRef で作られた
 * 同一の RefObject をそのまま渡している(新しい ref を作らない — 最下部への
 * 自動スクロールを行う ChatPanel.tsx 側の useEffect は `messagesRef.current`
 * を直接参照し続けるので、ここでこの div に同じ ref を貼るだけで動作は
 * 変わらない)。状態・副作用は一切持たない。
 */
export interface ChatMessageListProps {
  messagesRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  currentMessages: readonly ChatMessage[];
  currentConversationKey: string;
  loadingHistoryFor: string | null;
  isSending: boolean;
  backgroundTurnProjectId: string;
  selectedProjectId: string;
  backgroundTurnStatus: ChatTurnStatusDto;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
  activeStreamingText: string;
  sendElapsedSeconds: number;
}

export function ChatMessageList({
  messagesRef,
  onScroll,
  currentMessages,
  currentConversationKey,
  loadingHistoryFor,
  isSending,
  backgroundTurnProjectId,
  selectedProjectId,
  backgroundTurnStatus,
  isTicketOnBoard,
  onOpenTicket,
  activeStreamingText,
  sendElapsedSeconds,
}: ChatMessageListProps) {
  return (
    <div ref={messagesRef} className="chat-messages" role="log" aria-live="polite" onScroll={onScroll}>
      {currentMessages.length === 0 && loadingHistoryFor !== currentConversationKey && (
        <p className="empty-message">まだメッセージはありません</p>
      )}
      {loadingHistoryFor === currentConversationKey && <p className="chat-pending">履歴を読み込み中…</p>}
      {!isSending &&
        backgroundTurnProjectId === selectedProjectId &&
        backgroundTurnStatus.state === 'processing' &&
        backgroundTurnStatus.message !== undefined && (
          // プロジェクト単位の busy 粒度に合わせ、sessionId との突き合わせは行わない
          // (bdboard-3tw.104.22 の処理中バナーと同じスコープ。新規セッションは送信時点で
          // sessionId が未確定のため、厳密な会話一致は原理的にできない)。
          <div className="chat-message chat-message-user">
            <p className="chat-message-text">{backgroundTurnStatus.message}</p>
          </div>
        )}
      {!isSending && backgroundTurnProjectId === selectedProjectId && backgroundTurnStatus.state === 'processing' && (
        <p className="chat-pending" role="status">
          返信をバックグラウンドで処理中…
        </p>
      )}
      {!isSending && backgroundTurnProjectId === selectedProjectId && backgroundTurnStatus.state === 'completed' && (
        <p className="chat-pending" role="status">
          バックグラウンドの返信が完了しました。
        </p>
      )}
      {currentMessages.map((message, index) => (
        <ChatMessageRow
          key={`${message.at}-${index}`}
          message={message}
          isTicketOnBoard={isTicketOnBoard}
          onOpenTicket={onOpenTicket}
        />
      ))}
      {activeStreamingText !== '' && (
        <div className="chat-message chat-message-assistant chat-message-streaming">
          <p className="chat-message-text">{activeStreamingText}</p>
        </div>
      )}
      {/* bdboard-l1t.9 Opus レビュー N5: streaming で部分テキストが
          表示され始めたら「考え中…」は隠す(両方同時に出ると、もう
          テキストが見えているのに「考え中」と言い続けるのが不自然)。 */}
      {isSending && activeStreamingText === '' && (
        <p className="chat-pending">考え中…{sendElapsedSeconds}秒（最大3分かかることがあります）</p>
      )}
    </div>
  );
}
