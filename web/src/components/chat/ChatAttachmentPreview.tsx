import { formatImageSize, type ChatAttachment } from './attachments';

interface ChatAttachmentPreviewProps {
  attachments: readonly ChatAttachment[];
  isSending: boolean;
  onRemove: (attachmentId: string) => void;
}

/**
 * bdboard-sso1.2 (PR-B): 送信前の添付画像一覧 (chat-attachments) だけを移した、
 * 状態を持たない子コンポーネント。削除操作は呼び出し側が
 * conversationKey を閉じ込めた onRemove(attachmentId) として渡す。
 */
export function ChatAttachmentPreview({
  attachments,
  isSending,
  onRemove,
}: ChatAttachmentPreviewProps) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="chat-attachments" aria-label="送信前の添付画像" role="list">
      {attachments.map((attachment) => (
        <div className="chat-attachment" key={attachment.id} role="listitem">
          <img
            className="chat-attachment-preview"
            src={attachment.previewUrl}
            alt={`送信前の添付画像: ${attachment.name}`}
          />
          <span className="chat-attachment-details">
            <span className="chat-attachment-name">{attachment.name}</span>
            <span className="chat-attachment-size">
              {formatImageSize(attachment.size)}
            </span>
          </span>
          <button
            type="button"
            className="chat-attachment-remove"
            aria-label={`添付画像「${attachment.name}」を削除`}
            disabled={isSending}
            onClick={() => onRemove(attachment.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
