// bdboard-sso1.5 (PR-D): TicketDetailPanel.tsx の「タイトル」表示・編集
// ブロックを移動しただけのコンポーネント。state・mutation は
// useTicketTitleEditing (親で呼び出し) に残し、値とハンドラを props で
// 受け取る表示専用コンポーネント。JSX・className・aria属性・文言・DOM構造は
// 移動前から変えていない。
import { isImeComposingKeyEvent } from '../../imeGuard';
import { describeWriteError } from '../../writeAccessMessage';

export interface TicketTitleSectionProps {
  title: string | undefined;
  /** data !== undefined (編集ボタンの表示条件。ticket 自体の有無)。 */
  hasData: boolean;
  isLoading: boolean;
  titleEditing: boolean;
  titleDraft: string;
  onTitleDraftChange: (value: string) => void;
  canSaveTitle: boolean;
  isSaving: boolean;
  error: unknown;
  onStartTitleEdit: () => void;
  onCancelTitleEdit: () => void;
  onSaveTitle: () => void;
}

export function TicketTitleSection({
  title,
  hasData,
  isLoading,
  titleEditing,
  titleDraft,
  onTitleDraftChange,
  canSaveTitle,
  isSaving,
  error,
  onStartTitleEdit,
  onCancelTitleEdit,
  onSaveTitle,
}: TicketTitleSectionProps) {
  return titleEditing ? (
    <>
      <h2 id="detail-title" className="sr-only">
        {title ?? 'チケット詳細'}
      </h2>
      <div className="detail-title-edit">
        <label
          className="detail-field-label"
          htmlFor="detail-title-input"
        >
          タイトル
        </label>
        <input
          id="detail-title-input"
          type="text"
          className="detail-title-input"
          value={titleDraft}
          onChange={(event) => onTitleDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              if (isImeComposingKeyEvent(event)) {
                return;
              }
              event.preventDefault();
              onSaveTitle();
            }
          }}
          disabled={isSaving}
          maxLength={200}
        />
      <div className="detail-inline-edit-actions">
        <button
          type="button"
          className="btn btn-small"
          disabled={!canSaveTitle || isSaving}
          onClick={onSaveTitle}
        >
          {isSaving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={isSaving}
          onClick={onCancelTitleEdit}
        >
          キャンセル
        </button>
      </div>
      {error !== null && (
        <p className="error-message">
          {describeWriteError(
            error,
            'タイトルの更新に失敗しました',
          )}
        </p>
      )}
      </div>
    </>
  ) : (
    <div className="detail-title-row">
      <h2 id="detail-title" className="detail-title">
        {isLoading ? '読み込み中…' : title ?? 'チケット詳細'}
      </h2>
      {hasData && (
        <button
          type="button"
          className="btn btn-small detail-inline-edit-btn"
          aria-label="タイトルを編集"
          onClick={onStartTitleEdit}
        >
          編集
        </button>
      )}
    </div>
  );
}
