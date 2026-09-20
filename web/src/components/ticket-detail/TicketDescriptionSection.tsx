// bdboard-sso1.5 (PR-D): TicketDetailPanel.tsx の「Description」表示・編集
// ブロックを移動しただけのコンポーネント。state・mutation は
// useTicketDescriptionEditing (親で呼び出し) に残し、値とハンドラを props
// で受け取る表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造
// は移動前から変えていない。
import { MarkdownContent } from '../MarkdownContent';
import { describeWriteError } from '../../writeAccessMessage';

export interface TicketDescriptionSectionProps {
  description: string | undefined;
  descriptionEditing: boolean;
  descriptionDraft: string;
  onDescriptionDraftChange: (value: string) => void;
  canSaveDescription: boolean;
  isSaving: boolean;
  error: unknown;
  onStartDescriptionEdit: () => void;
  onCancelDescriptionEdit: () => void;
  onSaveDescription: () => void;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
}

export function TicketDescriptionSection({
  description,
  descriptionEditing,
  descriptionDraft,
  onDescriptionDraftChange,
  canSaveDescription,
  isSaving,
  error,
  onStartDescriptionEdit,
  onCancelDescriptionEdit,
  onSaveDescription,
  isTicketOnBoard,
  onOpenTicket,
}: TicketDescriptionSectionProps) {
  return (
    <div className="detail-section">
      <div className="detail-section-heading-row">
        <h3>Description</h3>
        {!descriptionEditing && (
          <button
            type="button"
            className="btn btn-small detail-inline-edit-btn"
            aria-label="Description を編集"
            onClick={onStartDescriptionEdit}
          >
            編集
          </button>
        )}
      </div>
      {descriptionEditing ? (
        <>
          <label
            className="detail-field-label"
            htmlFor="detail-description-input"
          >
            Description
          </label>
          <textarea
            id="detail-description-input"
            className="detail-description-input"
            value={descriptionDraft}
            onChange={(event) =>
              onDescriptionDraftChange(event.target.value)
            }
            disabled={isSaving}
            rows={6}
            maxLength={4000}
            aria-label="Description"
          />
          <div className="detail-inline-edit-actions">
            <button
              type="button"
              className="btn btn-small"
              disabled={!canSaveDescription || isSaving}
              onClick={onSaveDescription}
            >
              {isSaving
                ? '保存中…'
                : '保存'}
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={isSaving}
              onClick={onCancelDescriptionEdit}
            >
              キャンセル
            </button>
          </div>
          {error !== null && (
            <p className="error-message">
              {describeWriteError(
                error,
                'Description の更新に失敗しました',
              )}
            </p>
          )}
        </>
      ) : description !== undefined ? (
        <MarkdownContent
          text={description}
          isTicketOnBoard={isTicketOnBoard}
          onOpenTicket={onOpenTicket}
          className="markdown-detail"
        />
      ) : (
        <p className="detail-empty">（未設定）</p>
      )}
    </div>
  );
}
