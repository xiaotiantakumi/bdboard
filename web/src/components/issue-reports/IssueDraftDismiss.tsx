import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { dismissIssueDraft } from '../../api/issue-reports';
import { ISSUE_REPORTS_QUERY_KEY } from '../../hooks/useIssueReportPendingCount';
import { ISSUE_DRAFT_DISMISS_REASON_MAX_CHARS, describeIssueDraftDismissError } from './issueDraftErrors';

export interface IssueDraftDismissProps {
  readonly draftId: string;
  readonly onDismissed: () => void;
}

/** 見送り (PATCH drafts/:id/dismiss)。理由を一言 (1 行・200 文字まで) 添える。 */
export function IssueDraftDismiss({ draftId, onDismissed }: IssueDraftDismissProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  if (!open) {
    return (
      <div className="issue-draft-dismiss">
        <button type="button" className="btn btn-danger-outline" onClick={() => setOpen(true)}>
          見送る
        </button>
      </div>
    );
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reason.trim().length === 0) {
      setError('見送る理由を一言書いてください。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await dismissIssueDraft(draftId, reason);
      await queryClient.invalidateQueries({ queryKey: ISSUE_REPORTS_QUERY_KEY });
      setOpen(false);
      setReason('');
      onDismissed();
    } catch (caught) {
      setError(describeIssueDraftDismissError(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="issue-draft-dismiss issue-draft-dismiss-form" onSubmit={(event) => void handleSubmit(event)}>
      <label htmlFor={inputId} className="issue-draft-editor-label">
        見送る理由 (一言)
      </label>
      <input
        id={inputId}
        type="text"
        className="issue-draft-dismiss-reason"
        value={reason}
        maxLength={ISSUE_DRAFT_DISMISS_REASON_MAX_CHARS}
        onChange={(event) => setReason(event.target.value)}
      />
      {error !== null && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="issue-draft-editor-actions">
        <button type="submit" className="btn btn-danger" disabled={saving}>
          {saving ? '見送り中…' : '見送りにする'}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)} disabled={saving}>
          やめる
        </button>
      </div>
    </form>
  );
}
