import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../api';
import {
  patchIssueDraft,
  type IssueDraftDetailDto,
  type IssueDraftDetailResponseDto,
  type IssueDraftEditResponseDto,
  type IssueDraftTextEdit,
} from '../../api/issue-reports';
import {
  ISSUE_DRAFT_BODY_MAX_CHARS,
  ISSUE_DRAFT_TITLE_MAX_CHARS,
  describeIssueDraftEditError,
} from './issueDraftErrors';

export interface IssueDraftEditorProps {
  readonly draft: IssueDraftDetailDto;
  readonly onCancel: () => void;
  readonly onSaved: (response: IssueDraftEditResponseDto) => void;
  /** 入力が変わるたびに今の入力 (編集を始めたときの値のままなら null)。編集が外から閉じられたときに見せるため。 */
  readonly onInputChange?: (input: IssueDraftTextInput | null) => void;
}

export interface IssueDraftTextInput {
  readonly title: string;
  readonly body: string;
}

type TextBase = IssueDraftTextInput;

/**
 * 変えた欄だけを送る (サーバーは渡された欄にだけ「直した」印を立てる)。比べる相手は編集を始めたときの値: 編集中に
 * 裏で作り直された欄を、触っていないのに古い値で上書きしないため。
 */
function changedFields(base: TextBase, title: string, body: string): IssueDraftTextEdit {
  return {
    ...(title !== base.title ? { title } : {}),
    ...(body !== base.body ? { body } : {}),
  };
}

/**
 * 公開される題名・本文をその場で直す (PATCH drafts/:id)。保存に成功したら中身の問い合わせを応答で置き換え、
 * 一覧・件数も読み直す。失敗はステータスごとに利用者の言葉で出す (issueDraftErrors.ts)。
 */
export function IssueDraftEditor({ draft, onCancel, onSaved, onInputChange }: IssueDraftEditorProps) {
  const queryClient = useQueryClient();
  // 編集を始めたときの値。中身の問い合わせが裏で読み直されても (同じ指紋の新しい発生で自動の題名・本文が作り直される)、
  // 入力は消さずに残し、変わったことだけ知らせる (bdboard-4y8q.3.2 レビュー MINOR-1)。
  const [base] = useState<TextBase>(() => ({ title: draft.title, body: draft.body }));
  const changedUnderneath = draft.title !== base.title || draft.body !== base.body;
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();

  const tooLong = title.length > ISSUE_DRAFT_TITLE_MAX_CHARS || body.length > ISSUE_DRAFT_BODY_MAX_CHARS;
  const report = (nextTitle: string, nextBody: string) =>
    onInputChange?.(nextTitle !== base.title || nextBody !== base.body ? { title: nextTitle, body: nextBody } : null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const edit = changedFields(base, title, body);
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
      queryClient.setQueryData<IssueDraftDetailResponseDto>(['issue-reports', 'detail', draft.id], (previous) =>
        previous === undefined ? previous : { ...previous, draft: response.draft },
      );
      void queryClient.invalidateQueries({ queryKey: ['issue-reports'] });
      onSaved(response);
    } catch (caught) {
      // 409 (別の画面で見送り・投稿済みになった) は中身を読み直して、状態の表示と「直す」の有無を今の状態に合わせる。
      if (caught instanceof ApiError && caught.status === 409) void queryClient.invalidateQueries({ queryKey: ['issue-reports'] });
      setError(describeIssueDraftEditError(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="issue-draft-editor" onSubmit={(event) => void handleSubmit(event)}>
      {changedUnderneath && (
        <p className="issue-draft-notice" role="status">
          編集中に、この下書きが裏で更新されました (いま {draft.occurrenceCount} 回)。入力はそのまま残しています。保存すると、直した欄は今の入力で上書きします。
        </p>
      )}
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
        onChange={(event) => {
          setTitle(event.target.value);
          report(event.target.value, body);
        }}
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
        onChange={(event) => {
          setBody(event.target.value);
          report(title, event.target.value);
        }}
      />
      <p className="issue-draft-editor-hint">題名や本文を空にして保存すると、自動で組んだ内容に戻ります。</p>
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
