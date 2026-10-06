import { segmentExternalText, type InlineSegment } from './externalIssueText';

function InlineParts({ parts }: { readonly parts: readonly InlineSegment[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'text' ? (
          <span key={index}>{part.text}</span>
        ) : (
          <span key={index} className="external-issue-mark" data-testid="external-issue-invisible-mark">
            {part.marks}
          </span>
        ),
      )}
    </>
  );
}

/**
 * 第三者が書いた題名・本文を、文字のまま出す。見えない文字は `⟦U+200B⟧` の印に置き換え、HTML コメントは `⟦HTML コメント⟧` の印を先頭に付けて
 * 範囲を示す (コメントの文字は `<!-- … -->` ごとそのまま残る)。リンクにも HTML にもしない。印は文字で出すので、色が見えなくても分かる。
 */
export function ExternalMarkedText({ text }: { readonly text: string }) {
  return (
    <>
      {segmentExternalText(text).map((segment, index) => {
        if (segment.kind === 'comment') {
          return (
            <span key={index} className="external-issue-html-comment" data-testid="external-issue-html-comment">
              <span className="external-issue-mark">{segment.closed ? '⟦HTML コメント⟧' : '⟦HTML コメント (閉じていない)⟧'}</span>
              <InlineParts parts={segment.parts} />
            </span>
          );
        }
        return <InlineParts key={index} parts={[segment]} />;
      })}
    </>
  );
}
