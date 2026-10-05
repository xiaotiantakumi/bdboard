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
 *
 * 描けない本文 (深い入れ子でスタックが尽きる・長い強調の並びで主スレッドが止まる) では、タブ全体を落とさず、
 * 生の本文に倒す (レビュー MINOR-2)。見送り・編集はそのまま使える。
 */
import { Component, memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface SafeMarkdownPreviewProps {
  readonly text: string;
  readonly className?: string;
}

/** これより長い本文はプレビューを描かない (長い強調の並びは描画に数秒〜十数秒かかる)。投稿の上限は 65536 文字。 */
export const SAFE_PREVIEW_MAX_CHARS = 20_000;
/** 行頭の入れ子 (引用の `>`・リストの印・字下げ) がこれより深い本文はプレビューを描かない (スタックが尽きる)。 */
export const SAFE_PREVIEW_MAX_NESTING = 32;

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

/** 行頭の入れ子の深さのいちばん深い値 (引用の `>`、リストの印 `-*+` と `1.`、行頭の字下げ 4 文字で 1)。 */
export function maxLineNesting(text: string): number {
  let deepest = 0;
  for (const line of text.split('\n')) {
    const prefix = /^[\s>*+\-\d.)]*/.exec(line)?.[0] ?? '';
    const quotes = prefix.split('>').length - 1;
    const markers = (prefix.match(/(?:[*+-]|\d+[.)])(?=\s)/g) ?? []).length;
    const indent = Math.floor((/^[ \t]*/.exec(line)?.[0].length ?? 0) / 4);
    deepest = Math.max(deepest, quotes + markers + indent);
  }
  return deepest;
}

function tooHeavyReason(text: string): string | null {
  if (text.length > SAFE_PREVIEW_MAX_CHARS) return '本文が長いので、プレビューは省きました。';
  if (maxLineNesting(text) > SAFE_PREVIEW_MAX_NESTING) return '入れ子が深いので、プレビューは省きました。';
  return null;
}

function RawFallback({ text, reason }: { readonly text: string; readonly reason: string }) {
  return (
    <div className="safe-preview-fallback" data-testid="safe-preview-fallback">
      <p className="issue-draft-muted">{reason}生の本文で確かめてください (下に文字のまま出します)。</p>
      <pre className="issue-draft-raw-body">{text}</pre>
    </div>
  );
}

interface BoundaryProps {
  readonly text: string;
  readonly children: ReactNode;
}

/** 描画が throw しても、このプレビューだけを生の本文に倒す。本文が変わったら描き直しを試す。 */
class PreviewBoundary extends Component<BoundaryProps, { readonly failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.failed && previous.text !== this.props.text) this.setState({ failed: false });
  }

  render() {
    if (this.state.failed) return <RawFallback text={this.props.text} reason="プレビューを描けませんでした。" />;
    return this.props.children;
  }
}

function SafeMarkdownPreviewInner({ text, className }: SafeMarkdownPreviewProps) {
  const wrapperClassName = ['markdown-body', 'safe-markdown-preview', className].filter(Boolean).join(' ');
  const heavy = tooHeavyReason(text);
  return (
    <div className={wrapperClassName}>
      {heavy !== null ? (
        <RawFallback text={text} reason={heavy} />
      ) : (
        <PreviewBoundary text={text}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepUrl} components={components}>
            {text}
          </ReactMarkdown>
        </PreviewBoundary>
      )}
    </div>
  );
}

/** 親の再描画 (保存の通知・モードの切り替え) ごとに Markdown を作り直さない (本文は最大 65536 文字)。 */
export const SafeMarkdownPreview = memo(SafeMarkdownPreviewInner);
