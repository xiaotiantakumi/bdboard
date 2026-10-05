import {
  ISSUE_DRAFTS_API_PATH,
  type IssueDraftDetailDto,
  type IssueDraftImageDto,
  type IssueDraftLocalOnlyDto,
} from '../../api/issue-reports';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';

export interface IssueDraftLocalSectionProps {
  readonly draft: IssueDraftDetailDto;
  readonly images: readonly IssueDraftImageDto[];
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 元のエラーの全文。生ログが無い古い下書きは、表示用の先頭・末尾の切り出しに倒す。 */
function ErrorText({ localOnly }: { readonly localOnly: IssueDraftLocalOnlyDto }) {
  if (nonEmpty(localOnly.errorTextRaw)) {
    return <pre className="issue-draft-local-pre">{localOnly.errorTextRaw}</pre>;
  }
  if (nonEmpty(localOnly.errorTextHead) || nonEmpty(localOnly.errorTextTail)) {
    return (
      <pre className="issue-draft-local-pre">
        {localOnly.errorTextHead ?? ''}
        {'\n…\n'}
        {localOnly.errorTextTail ?? ''}
      </pre>
    );
  }
  return <p className="issue-draft-muted">エラー本文はありません。</p>;
}

const FREE_TEXT_FIELDS: readonly { key: 'symptomRaw' | 'causeRaw' | 'preventionRaw' | 'agentNoteRaw'; label: string }[] = [
  { key: 'symptomRaw', label: '症状' },
  { key: 'causeRaw', label: '原因' },
  { key: 'preventionRaw', label: '防ぎ方' },
  { key: 'agentNoteRaw', label: 'メモ' },
];

/**
 * 2) 投稿されない手元の情報。たたんで出す (開くまで中身は描かない — frontend-gotchas の details の罠を避けるため、
 * 中身の要素に display を当てない)。トンネル経由 (restricted) ではサーバーが生ログ・自由記述・パスを省くので、その旨を出す。
 */
export function IssueDraftLocalSection({ draft, images }: IssueDraftLocalSectionProps) {
  const localOnly = draft.localOnly ?? {};
  const projects = Array.isArray(draft.occurredProjects) ? draft.occurredProjects : [];
  return (
    <details className="issue-draft-section issue-draft-local">
      <summary className="issue-draft-section-title">投稿されない手元の情報</summary>
      {draft.restricted && (
        <p className="issue-draft-notice">
          トンネル経由のため、元のエラー本文・症状などの生の文・プロジェクトのフルパスは表示しません。PC のローカル画面で開いてください。
        </p>
      )}
      <dl className="issue-draft-local-list">
        <dt>発生したプロジェクト</dt>
        <dd>
          {projects.length === 0 ? (
            <span className="issue-draft-muted">記録がありません</span>
          ) : (
            <ul className="issue-draft-projects">
              {projects.map((project, index) => (
                <li key={`${project.name}-${index}`}>
                  <span className="issue-draft-project-name">{project.name}</span>
                  {nonEmpty(project.path) && <code className="issue-draft-project-path">{project.path}</code>}
                  <span className="issue-draft-muted"> 最後: {formatAbsoluteTime(project.lastSeenAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </dd>
        {nonEmpty(draft.source) && (
          <>
            <dt>出どころ</dt>
            <dd>
              <code>{draft.source}</code>
            </dd>
          </>
        )}
        {nonEmpty(draft.catalogSlug) && (
          <>
            <dt>failure-catalog</dt>
            <dd>
              <code>{draft.catalogSlug}</code>
            </dd>
          </>
        )}
        <dt>指紋</dt>
        <dd>
          <code className="issue-draft-fingerprint">{draft.fingerprint}</code>
        </dd>
      </dl>
      {!draft.restricted && (
        <>
          <h4 className="issue-draft-local-heading">
            元のエラーの全文{localOnly.errorTextTruncated === true ? ' (保存の上限で一部を省いています)' : ''}
          </h4>
          <ErrorText localOnly={localOnly} />
          {FREE_TEXT_FIELDS.filter((field) => nonEmpty(localOnly[field.key])).map((field) => (
            <div key={field.key}>
              <h4 className="issue-draft-local-heading">{field.label}</h4>
              <pre className="issue-draft-local-pre">{localOnly[field.key]}</pre>
            </div>
          ))}
        </>
      )}
      {images.length > 0 && (
        <>
          <h4 className="issue-draft-local-heading">添付画像 ({images.length} 枚)</h4>
          <ul className="issue-draft-images">
            {images.map((image) => (
              <li key={image.fileName}>
                {image.url.startsWith(`${ISSUE_DRAFTS_API_PATH}/`) ? (
                  // この bdboard 自身が配る画像だけを開けるようにする (外へは飛ばない)。開くまでは読み込まない。
                  <a href={image.url} target="_blank" rel="noreferrer noopener">
                    {image.fileName}
                  </a>
                ) : (
                  <span>{image.fileName}</span>
                )}
                <span className="issue-draft-muted"> {Math.ceil(image.byteLength / 1024)} KB</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
