import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import {
  patchIssueDraft,
  type IssueDraftDetailDto,
  type IssueDraftDetailResponseDto,
  type IssueDraftEditResponseDto,
  type IssueDraftTextEdit,
} from '../../api/issue-reports';
import { ISSUE_REPORTS_QUERY_KEY, issueReportDetailQueryKey } from '../../hooks/useIssueReportPendingCount';
import {
  ISSUE_DRAFT_BODY_MAX_CHARS,
  ISSUE_DRAFT_TITLE_MAX_CHARS,
  describeIssueDraftEditError,
} from './issueDraftErrors';

export interface IssueDraftEditorProps {
  readonly draft: IssueDraftDetailDto;
  readonly onCancel: () => void;
  readonly onSaved: (response: IssueDraftEditResponseDto) => void;
}

/** 変えた欄だけを送る (サーバーは渡された欄にだけ「直した」印を立てる)。 */
function changedFields(draft: IssueDraftDetailDto, title: string, body: string): IssueDraftTextEdit {
  return {
    ...(title !== draft.title ? { title } : {}),
    ...(body !== draft.body ? { body } : {}),
  };
}

/**
 * 公開される題名・本文をその場で直す (PATCH drafts/:id)。保存に成功したら中身の問い合わせを応答で置き換え、
 * 一覧・件数も読み直す。失敗はステータスごとに利用者の言葉で出す (issueDraftErrors.ts)。
 */
export function IssueDraftEditor({ draft, onCancel, onSaved }: IssueDraftEditorProps) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();

  const tooLong = title.length > ISSUE_DRAFT_TITLE_MAX_CHARS || body.length > ISSUE_DRAFT_BODY_MAX_CHARS;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const edit = changedFields(draft, title, body);
    if (edit.title === undefined && edit.body === undefined) {
      onCancel();
      return;
    }
    if (tooLong) {
      setError(`長すぎて保存できません。題名は ${ISSUE_DRAFT_TITLE_MAX_CHARS} 文字、本文は ${ISSUE_DRAFT_BODY_MAX_CHARS} 文字までです。`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await patchIssueDraft(draft.id, edit);
      // 応答の draft は GET の draft と同じ形 (images・latestHarnessVersion は載らないので前の値を残す)。
      queryClient.setQueryData<IssueDraftDetailResponseDto>(issueReportDetailQueryKey(draft.id), (previous) =>
        previous === undefined ? previous : { ...previous, draft: response.draft },
      );
      void queryClient.invalidateQueries({ queryKey: ISSUE_REPORTS_QUERY_KEY });
      onSaved(response);
    } catch (caught) {
      setError(describeIssueDraftEditError(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="issue-draft-editor" onSubmit={(event) => void handleSubmit(event)}>
      <label htmlFor={titleId} className="issue-draft-editor-label">
        題名
        <span className="issue-draft-editor-count">
          {title.length} / {ISSUE_DRAFT_TITLE_MAX_CHARS}
        </span>
      </label>
      <input
        id={titleId}
        className="issue-draft-editor-title"
        type="text"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label htmlFor={bodyId} className="issue-draft-editor-label">
        本文 (Markdown)
        <span className="issue-draft-editor-count">
          {body.length} / {ISSUE_DRAFT_BODY_MAX_CHARS}
        </span>
      </label>
      <textarea
        id={bodyId}
        className="issue-draft-editor-body"
        value={body}
        rows={14}
        onChange={(event) => setBody(event.target.value)}
      />
      {error !== null && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="issue-draft-editor-actions">
        <button type="submit" className="btn" disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          やめる
        </button>
      </div>
    </form>
  );
}
