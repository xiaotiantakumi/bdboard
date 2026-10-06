import { useState } from 'react';
import type { ExternalTextChecks } from '../../api/issue-reports-external';
import { togglePressedProps } from '../toggleGroupA11y';
import { ExternalMarkedText } from './ExternalMarkedText';
import { previewHeavyReason, SafeMarkdownPreview } from './SafeMarkdownPreview';

export interface ExternalIssueBodyProps {
  readonly body: string;
  /** 本文の検査の結果 (プレビューで見えなくなるものがあるかの判断に使う)。 */
  readonly checks: ExternalTextChecks;
}

/**
 * 届いた issue の本文 (第三者の文章)。既定は生の本文で、見えない文字と HTML コメントに印を付ける。人が「プレビュー」に切り替えたときだけ
 * SafeMarkdownPreview (リンクを <a href> にせず、画像を読み込まない) で出す。重い本文はプレビューを使えず、生の本文のまま
 * (SafeMarkdownPreview 自身のフォールバックは印の無い文字なので、そこへ落とさない)。
 */
export function ExternalIssueBody({ body, checks }: ExternalIssueBodyProps) {
  const [preview, setPreview] = useState(false);
  const heavyReason = previewHeavyReason(body);
  const showPreview = preview && heavyReason === null;
  const hidesSomething = checks.invisibleChars.total > 0 || checks.htmlComments.count > 0;

  return (
    <div className="external-issue-body">
      <div className="toggle-group external-issue-mode-toggle" role="group" aria-label="本文の表示">
        <button
          type="button"
          className={`toggle-btn${showPreview ? '' : ' active'}`}
          {...togglePressedProps(!showPreview)}
          onClick={() => setPreview(false)}
        >
          生の本文
        </button>
        <button
          type="button"
          className={`toggle-btn${showPreview ? ' active' : ''}`}
          {...togglePressedProps(showPreview)}
          disabled={heavyReason !== null}
          onClick={() => setPreview(true)}
        >
          プレビュー
        </button>
      </div>
      {heavyReason !== null && <p className="issue-draft-muted">{heavyReason}生の本文のままにします。</p>}
      {showPreview ? (
        <>
          {hidesSomething && (
            <p className="issue-draft-notice">プレビューでは見えない文字と HTML コメントが見えません。生の本文で確かめてください。</p>
          )}
          <SafeMarkdownPreview text={body} />
        </>
      ) : (
        <>
          <p className="issue-draft-muted external-issue-legend">
            「⟦U+200B⟧」のような印は見えない文字、「⟦HTML コメント⟧」から始まる部分は HTML コメント (GitHub では表示されません) です。
          </p>
          <pre className="external-issue-raw-body">
            <ExternalMarkedText text={body} />
          </pre>
        </>
      )}
    </div>
  );
}
