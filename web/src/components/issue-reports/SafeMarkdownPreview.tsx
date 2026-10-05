/**
 * 不具合報告の本文を GitHub での見え方に近い形で描く Markdown プレビュー (bdboard-4y8q.3.2)。
 *
 * docs/ISSUE-REPORTING.md 5節「プレビュー表示時の注意」: プレビューを描いただけで外部へリクエストが飛ぶと、
 * 人がまだ何も確かめていない時点で下書きの存在とタイミングを外へ知らせてしまう (トラッキングピクセル)。
 * そのため:
 *   - 画像の記法 (`![alt](url)`) は <img> にせず、「画像: alt (url)」という文字にする (読み込まない)。
 *   - リンクは <a href> にせず、リンクの文字と行き先を文字で出す (押しても飛ばない。行き先を目で確かめる)。
 *   - 生の HTML (`<img src=…>` など) は react-markdown の既定どおり描かない (rehype-raw を入れない)。
 * MarkdownContent (チケット本文用) はリンクを開けるので使い回さない。
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface SafeMarkdownPreviewProps {
  readonly text: string;
  readonly className?: string;
}

/** react-markdown が渡す url は、既定の urlTransform で危険な形が空にされている。表示用には生の値を残したいので素通しする。 */
function keepUrl(url: string): string {
  return url;
}

const components: Components = {
  img: ({ src, alt }) => (
    <span className="safe-preview-image" data-testid="safe-preview-image">
      {`画像: ${alt !== undefined && alt.length > 0 ? alt : '(説明なし)'}`}
      {typeof src === 'string' && src.length > 0 ? <span className="safe-preview-url">{` (${src})`}</span> : null}
      <span className="safe-preview-note"> — 読み込みません</span>
    </span>
  ),
  a: ({ href, children }) => (
    <span className="safe-preview-link" data-testid="safe-preview-link">
      {children}
      {typeof href === 'string' && href.length > 0 ? <span className="safe-preview-url">{` <${href}>`}</span> : null}
    </span>
  ),
};

export function SafeMarkdownPreview({ text, className }: SafeMarkdownPreviewProps) {
  const wrapperClassName = ['markdown-body', 'safe-markdown-preview', className].filter(Boolean).join(' ');
  return (
    <div className={wrapperClassName}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepUrl} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
