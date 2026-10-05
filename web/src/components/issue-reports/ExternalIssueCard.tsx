import { useId, useState } from 'react';
import type { ExternalIssueDto, ExternalTextChecks } from '../../api/issue-reports-external';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';
import { ExternalIssueBody } from './ExternalIssueBody';
import { ExternalMarkedText } from './ExternalMarkedText';
import { describeCheckCounts } from './externalIssueText';

function CheckCounts({ heading, checks }: { readonly heading: string; readonly checks: ExternalTextChecks }) {
  return (
    <section className="external-issue-checks-section">
      <h4 className="external-issue-checks-heading">{heading}</h4>
      <dl className="external-issue-checks">
        {describeCheckCounts(checks).map((item) => (
          <div key={item.key} className="external-issue-check">
            <dt>{item.label}</dt>
            <dd>
              {item.count}
              {item.detail !== undefined && <small className="external-issue-check-detail">{item.detail}</small>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * 届いた issue の 1 件 (bdboard-4y8q.9.5)。番号・題名・作者・関係・機械の検査の数 (判定の言葉は使わない)・GitHub の URL (文字のまま)。
 * 本文は「本文を見る」で開いたときだけ描く (一覧に本文を最初から全部は描かない = 一覧の重さの対策。逸脱表 1)。
 */
export function ExternalIssueCard({ issue }: { readonly issue: ExternalIssueDto }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const titleHasFindings = describeCheckCounts(issue.checks.title).some((item) => item.count > 0);

  return (
    <li className="external-issue-card">
      <h3 className="external-issue-title">
        #{issue.number} <ExternalMarkedText text={issue.title} />
      </h3>
      <p className="external-issue-meta">
        <span>作者: {issue.author ?? '(不明)'}</span>
        {issue.authorAssociation !== null && <span>関係: {issue.authorAssociation}</span>}
        <span>
          更新: <time dateTime={issue.updatedAt}>{formatAbsoluteTime(issue.updatedAt)}</time>
        </span>
        <code className="external-issue-url">{issue.url}</code>
      </p>
      {issue.needsRejudge && (
        <p className="issue-draft-notice" role="status">
          GitHub 側で編集されました (判定のやり直しが必要)
        </p>
      )}
      {(issue.titleTruncated || issue.bodyTruncated) && (
        <ul className="external-issue-truncation">
          {issue.titleTruncated && <li>題名は長いため途中までです (元は {issue.titleLength} 文字)</li>}
          {issue.bodyTruncated && <li>本文は長いため途中までです (元は {issue.bodyLength} 文字)</li>}
        </ul>
      )}
      <CheckCounts heading="本文の検査" checks={issue.checks.body} />
      {titleHasFindings && <CheckCounts heading="題名の検査" checks={issue.checks.title} />}
      <button
        type="button"
        className="btn external-issue-body-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '本文をたたむ' : '本文を見る'}
      </button>
      <div id={bodyId}>{open && <ExternalIssueBody body={issue.body} checks={issue.checks.body} />}</div>
    </li>
  );
}
