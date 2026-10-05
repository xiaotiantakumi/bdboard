import type { IssueDraftTextInput } from './IssueDraftEditor';
import { draftStatusLabel } from './issueDraftText';

export interface IssueDraftEditClosedNoticeProps {
  /** 今の状態 (pending 以外)。 */
  readonly status: string;
  /** 閉じたときに入力していた内容。編集を始めたときから変えていなければ null。 */
  readonly input: IssueDraftTextInput | null;
}

/**
 * 編集中に、別の画面で見送り・投稿済みになったため編集を閉じたことの説明 (bdboard-4y8q.3.2 再レビュー MINOR-A)。
 * 保存の 409 のあとの読み直しでも、フォーカスの読み直しでも同じ形で出す。入力していた内容は保存していないので、
 * 写せるように読み取り専用の欄で一度だけ見せる (ほかの表示に切り替えると消える)。
 */
export function IssueDraftEditClosedNotice({ status, input }: IssueDraftEditClosedNoticeProps) {
  return (
    <div className="issue-draft-notice issue-draft-edit-closed" role="status">
      <p>
        別の画面で「{draftStatusLabel(status)}」になっていたので、編集を閉じました。
        {input !== null ? '入力していた内容は保存していません。必要なら下から写してください。' : ''}
      </p>
      {input !== null && (
        <>
          <label className="issue-draft-editor-label">
            入力していた題名
            <input className="issue-draft-editor-title" type="text" readOnly value={input.title} />
          </label>
          <label className="issue-draft-editor-label">
            入力していた本文
            <textarea className="issue-draft-editor-body" readOnly rows={8} value={input.body} />
          </label>
        </>
      )}
    </div>
  );
}
