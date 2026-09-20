import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { fetchTicketAttachments, type AttachmentDto } from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useHistoryBackClose } from '../hooks/useHistoryBackClose';

export interface TicketAttachmentsProps {
  ticketId: string;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentLightbox({
  attachment,
  onClose,
}: {
  attachment: AttachmentDto;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const { requestClose } = useHistoryBackClose({
    panelId: 'ticket-attachment-lightbox',
    onClose,
  });
  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: requestClose,
  });

  return (
    <div className="overlay attachment-lightbox-overlay" onClick={requestClose} role="presentation">
      <div
        ref={panelRef}
        className="attachment-lightbox-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="添付画像"
        tabIndex={-1}
      >
        <div className="attachment-lightbox-header">
          <span className="attachment-lightbox-meta">{formatByteSize(attachment.byteLength)}</span>
          <button ref={closeButtonRef} type="button" className="btn" onClick={requestClose}>
            閉じる
          </button>
        </div>
        <img
          className="attachment-lightbox-image"
          src={attachment.url}
          alt="添付画像の拡大表示"
        />
      </div>
    </div>
  );
}

export function TicketAttachments({ ticketId }: TicketAttachmentsProps) {
  const { data } = useQuery({
    queryKey: ['ticket-attachments', ticketId],
    queryFn: () => fetchTicketAttachments(ticketId),
  });
  const [openedIndex, setOpenedIndex] = useState<number | null>(null);

  const attachments = data?.attachments ?? [];
  if (attachments.length === 0) {
    return null;
  }

  const opened = openedIndex !== null ? attachments[openedIndex] : undefined;

  return (
    <div className="detail-section">
      <h3>添付画像</h3>
      <ul className="attachment-thumbnail-list">
        {attachments.map((attachment, index) => (
          <li key={attachment.fileName} className="attachment-thumbnail-item">
            <button
              type="button"
              className="attachment-thumbnail-button"
              onClick={() => setOpenedIndex(index)}
            >
              <img
                className="attachment-thumbnail-image"
                src={attachment.url}
                alt="添付画像のサムネイル"
                loading="lazy"
              />
            </button>
          </li>
        ))}
      </ul>
      {opened !== undefined && (
        <AttachmentLightbox attachment={opened} onClose={() => setOpenedIndex(null)} />
      )}
    </div>
  );
}
