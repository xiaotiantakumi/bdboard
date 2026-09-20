import { MarkdownContent } from '../MarkdownContent';
import { formatImageSize } from './attachments';
import type { ChatMessage } from './messages';

interface ChatMessageRowProps {
  message: ChatMessage;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
}

/**
 * bdboard-sso1.2 (PR-B): ChatPanel.tsx の chat-messages 一覧 .map() 内の1メッセージ分の
 * 表示だけを移した、状態を持たない子コンポーネント。key は呼び出し側の .map() で
 * これまで通り `${message.at}-${index}` として付与する(このコンポーネントには渡さない)。
 */
export function ChatMessageRow({
  message,
  isTicketOnBoard,
  onOpenTicket,
}: ChatMessageRowProps) {
  return (
    <div className={`chat-message chat-message-${message.role}`}>
      {message.role === 'assistant' ? (
        <MarkdownContent
          text={message.text}
          isTicketOnBoard={isTicketOnBoard}
          onOpenTicket={onOpenTicket}
          className="chat-message-text"
        />
      ) : (
        <p className="chat-message-text">{message.text}</p>
      )}
      {message.images !== undefined && message.images.length > 0 && (
        <div className="chat-message-images" aria-label="添付画像" role="list">
          {message.images.map((image, imageIndex) => (
            <figure key={`${image.previewUrl}-${imageIndex}`} role="listitem">
              <img src={image.previewUrl} alt={`添付画像: ${image.name}`} />
              <figcaption>
                {image.name} · {formatImageSize(image.size)}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {message.failedTools !== undefined &&
        message.failedTools.length > 0 && (
          <p className="chat-message-failed-tools" role="alert">
            一部のツール呼び出しが実行できませんでした:{' '}
            {message.failedTools.join(', ')}
          </p>
        )}
      {message.agentWarnings !== undefined &&
        message.agentWarnings.length > 0 && (
          <p className="chat-message-agent-warnings" role="alert">
            エージェントの警告: {message.agentWarnings.join('; ')}
          </p>
        )}
    </div>
  );
}
