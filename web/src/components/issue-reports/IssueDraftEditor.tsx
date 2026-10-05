import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api';
import {
  patchIssueDraft,
  type IssueDraftDetailDto,
  type IssueDraftDetailResponseDto,
  type IssueDraftEditResponseDto,
  type IssueDraftTextEdit,
} from '../../api/issue-reports';
import { IssueDraftFieldReset } from './IssueDraftFieldReset';
import {
  ERROR_TEXT_TRIMMED_NOTE,
  ISSUE_DRAFT_BODY_MAX_CHARS,
  ISSUE_DRAFT_TITLE_MAX_CHARS,
  describeIssueDraftEditError,
} from './issueDraftErrors';

export interface IssueDraftEditorProps {
  readonly draft: IssueDraftDetailDto;
  /**
   * 表示中の下書きの ETag (bdboard-mqoa)。保存と「自動の文に戻す」の PATCH に If-Match で付け、読んだあとにほかの場所で
   * 下書きが変わっていれば 412 にしてもらう (最後の書き込みが勝つ、をやめる)。無ければ (古いサーバー) 付けない。
   */
  readonly etag?: string;
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
type TextField = keyof IssueDraftTextInput;

const FIELD_LABELS: Readonly<Record<TextField, string>> = { title: '題名', body: '本文' };

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
 * 「直した」印の付いた欄には「自動の文に戻す」ボタンを出す (bdboard-494n。IssueDraftFieldReset)。押すとその欄だけを空にした
 * PATCH を送り、編集欄は開いたまま、もう片方の欄の未保存の入力を残す。
 * どちらの PATCH にも表示中の下書きの ETag を If-Match で付ける。412 (読んだあとにほかの場所で変わった) は、最新を読み直して
 * その旨を出し、入力は消さない (編集欄の入力は読み直しで置き換わらない。「編集を始めたときの値」と比べて、変わった欄だけを送る)。
 */
export function IssueDraftEditor({ draft, etag, onCancel, onSaved, onInputChange }: IssueDraftEditorProps) {
  const queryClient = useQueryClient();
  // 編集を始めたときの値。中身の問い合わせが裏で読み直されても (同じ指紋の新しい発生で自動の題名・本文が作り直される)、
  // 入力は消さずに残し、変わったことだけ知らせる (bdboard-4y8q.3.2 レビュー MINOR-1)。自動の文へ戻した欄だけは、戻した値に更新する
  // (更新しないと、戻したあとの保存で自動の文を「直した」文として送ってしまう)。
  const [base, setBase] = useState<TextBase>(() => ({ title: draft.title, body: draft.body }));
  const changedUnderneath = draft.title !== base.title || draft.body !== base.body;
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState<TextField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const busy = saving || resetting !== null;
  const tooLong = title.length > ISSUE_DRAFT_TITLE_MAX_CHARS || body.length > ISSUE_DRAFT_BODY_MAX_CHARS;
  const reportInput = (nextBase: TextBase, nextTitle: string, nextBody: string) =>
    onInputChange?.(nextTitle !== nextBase.title || nextBody !== nextBase.body ? { title: nextTitle, body: nextBody } : null);

  const sendEdit = (edit: IssueDraftTextEdit) =>
    etag === undefined ? patchIssueDraft(draft.id, edit) : patchIssueDraft(draft.id, edit, { ifMatch: etag });

  /**
   * 保存・戻すの成功: 応答の draft は GET の draft と同じ形 (images・latestHarnessVersion は載らないので前の値を残す)。応答の ETag も
   * 一緒に置く (次の保存の If-Match になる)。応答に無ければ消す: 古い ETag を残すと、次の保存が必ず 412 になる。
   */
  const applyResponse = (response: IssueDraftEditResponseDto) => {
    queryClient.setQueryData<IssueDraftDetailResponseDto>(['issue-reports', 'detail', draft.id], (previous) => {
      if (previous === undefined) return previous;
      const { etag: _stale, ...rest } = previous;
      return { ...rest, draft: response.draft, ...(response.etag !== undefined ? { etag: response.etag } : {}) };
    });
    void queryClient.invalidateQueries({ queryKey: ['issue-reports'] });
  };

  /**
   * 失敗の表示。409 (別の画面で見送り・投稿済みになった) は中身を読み直して、状態の表示と「直す」の有無を今の状態に合わせる。
   * 412 (読んだあとにほかの場所で変わった) も読み直す: 新しい ETag と最新の中身が届き、次の保存は今の下書きへの上書きとして通る。
   */
  const showFailure = (caught: unknown) => {
    if (caught instanceof ApiError && (caught.status === 409 || caught.status === 412)) {
      void queryClient.invalidateQueries({ queryKey: ['issue-reports'] });
    }
    setError(describeIssueDraftEditError(caught));
  };

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
    setResetNotice(null);
    try {
      const response = await sendEdit(edit);
      applyResponse(response);
      onSaved(response);
    } catch (caught) {
      showFailure(caught);
    } finally {
      setSaving(false);
    }
  };

  /**
   * 1 つの欄を自動の文へ戻す: その欄だけを空にした PATCH (サーバーは見える文字が無い欄を戻す。bdboard-pnvj・bdboard-ov0t)。
   * 入力の差分を見ずに送る — '' と「直した」印のまま保存された欄は、編集欄が初めから空で、保存では何も送らないため。
   * 成功したら、その欄の入力と「編集を始めたときの値」を戻した値にそろえる。もう片方の欄の入力はそのまま残す。
   */
  const handleReset = async (field: TextField) => {
    setResetting(field);
    setError(null);
    setResetNotice(null);
    try {
      const response = await sendEdit(field === 'title' ? { title: '' } : { body: '' });
      applyResponse(response);
      const restored = response.draft[field];
      const nextBase: TextBase = { ...base, [field]: restored };
      const nextTitle = field === 'title' ? restored : title;
      const nextBody = field === 'body' ? restored : body;
      setBase(nextBase);
      setTitle(nextTitle);
      setBody(nextBody);
      reportInput(nextBase, nextTitle, nextBody);
      setResetNotice(
        `${FIELD_LABELS[field]}を自動の文に戻しました。${response.errorTextTrimmed ? ERROR_TEXT_TRIMMED_NOTE : ''}`,
      );
      // 押したボタンは「直した」印が外れて消えるので、フォーカスを戻した欄へ移す (body へ落とさない)。編集欄の外へ移していたら奪わない。
      const active = document.activeElement;
      if (active === null || active === document.body || formRef.current?.contains(active) === true) {
        (field === 'title' ? titleRef : bodyRef).current?.focus();
      }
    } catch (caught) {
      showFailure(caught);
    } finally {
      setResetting(null);
    }
  };

  const resetControl = (field: TextField) => {
    if (!(field === 'title' ? draft.titleEditedByUser : draft.bodyEditedByUser)) return null;
    const input = field === 'title' ? title : body;
    return (
      <IssueDraftFieldReset
        label={FIELD_LABELS[field]}
        // 捨てる内容がある: 直した文 (保存済み) が空でない、またはまだ保存していない入力がある。空白だけの欄は確認なしで戻す。
        needsConfirm={draft[field].trim() !== '' || input !== base[field]}
        disabled={busy}
        onReset={() => void handleReset(field)}
      />
    );
  };

  return (
    <form ref={formRef} className="issue-draft-editor" onSubmit={(event) => void handleSubmit(event)}>
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
        ref={titleRef}
        id={titleId}
        className="issue-draft-editor-title"
        type="text"
        value={title}
        readOnly={resetting !== null}
        onChange={(event) => {
          setTitle(event.target.value);
          reportInput(base, event.target.value, body);
        }}
      />
      {resetControl('title')}
      <label htmlFor={bodyId} className="issue-draft-editor-label">
        本文 (Markdown)
        <span className="issue-draft-editor-count">
          {body.length} / {ISSUE_DRAFT_BODY_MAX_CHARS}
        </span>
      </label>
      <textarea
        ref={bodyRef}
        id={bodyId}
        className="issue-draft-editor-body"
        value={body}
        rows={14}
        readOnly={resetting !== null}
        onChange={(event) => {
          setBody(event.target.value);
          reportInput(base, title, event.target.value);
        }}
      />
      {resetControl('body')}
      <p className="issue-draft-editor-hint">題名や本文を空にして保存すると、自動で組んだ内容に戻ります。</p>
      {resetNotice !== null && (
        <p className="issue-draft-notice" role="status">
          {resetNotice}
        </p>
      )}
      {error !== null && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="issue-draft-editor-actions">
        <button type="submit" className="btn" disabled={busy}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          やめる
        </button>
      </div>
    </form>
  );
}
