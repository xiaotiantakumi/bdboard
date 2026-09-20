import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { deleteTicketAttachment, fetchTicketAttachments, type AttachmentDto } from '../api';
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
  ticketId,
  attachment,
  onClose,
}: {
  ticketId: string;
  attachment: AttachmentDto;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  // bdboard-ij1h: 誤操作防止のため二段階確認 (HygienePanel の
  // hygiene-repair-confirm と同じ「ボタンがその場で確定/キャンセルの
  // ペアに差し替わる」流儀)。
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const { requestClose } = useHistoryBackClose({
    panelId: 'ticket-attachment-lightbox',
    onClose,
  });
  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: requestClose,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await deleteTicketAttachment(ticketId, attachment.fileName);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ticket-attachments', ticketId] });
      onClose();
    },
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
        <div className="attachment-lightbox-toolbar">
          {isConfirmingDelete ? (
            <div className="attachment-lightbox-delete-confirm">
              <button
                type="button"
                className="btn attachment-lightbox-delete-confirm-btn"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
              >
                {deleteMutation.isPending ? '削除中…' : '確定: 削除'}
              </button>
              <button
                type="button"
                className="btn attachment-lightbox-delete-cancel"
                disabled={deleteMutation.isPending}
                onClick={() => setIsConfirmingDelete(false)}
              >
                キャンセル
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn attachment-lightbox-delete-btn"
              onClick={() => setIsConfirmingDelete(true)}
            >
              削除
            </button>
          )}
          {deleteMutation.isError && (
            <p className="attachment-lightbox-delete-error" role="alert">
              削除に失敗しました。もう一度お試しください。
            </p>
          )}
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
        <AttachmentLightbox
          ticketId={ticketId}
          attachment={opened}
          onClose={() => setOpenedIndex(null)}
        />
      )}
    </div>
  );
}
