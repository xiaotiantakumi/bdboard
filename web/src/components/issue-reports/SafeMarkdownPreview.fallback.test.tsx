import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  SAFE_PREVIEW_MAX_CHARS,
  SAFE_PREVIEW_MAX_MARKS,
  SAFE_PREVIEW_MAX_NESTING,
  SafeMarkdownPreview,
  countEmphasisMarks,
  maxLineNesting,
} from './SafeMarkdownPreview';

// 本文に 'BOOM' があると描画で throw する react-markdown (境界の確認用)。それ以外は文字をそのまま出す。
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    if (children.includes('BOOM')) throw new RangeError('Maximum call stack size exceeded');
    return <p data-testid="rendered-markdown">{children}</p>;
  },
}));

describe('SafeMarkdownPreview fallbacks (bdboard-4y8q.3.2 review MINOR-2)', () => {
  it('measures line-start nesting from quotes, list markers and indentation', () => {
    expect(maxLineNesting('plain\n2026-10-04 error at line 3')).toBe(0);
    expect(maxLineNesting('> > quoted\n- item\n    - nested')).toBe(2);
    expect(maxLineNesting('> '.repeat(2000) + 'x')).toBe(2000);
  });

  it('falls back to the raw text for a deeply nested body instead of rendering it', () => {
    const text = '> '.repeat(SAFE_PREVIEW_MAX_NESTING + 1) + 'deep';
    render(<SafeMarkdownPreview text={text} />);
    expect(screen.queryByTestId('rendered-markdown')).toBeNull();
    expect(screen.getByTestId('safe-preview-fallback')).toHaveTextContent('入れ子が深いので、プレビューは省きました。');
    expect(screen.getByText(text.trim())).toBeInTheDocument();
  });

  it('falls back to the raw text for a body over the length cap', () => {
    render(<SafeMarkdownPreview text={'a'.repeat(SAFE_PREVIEW_MAX_CHARS + 1)} />);
    expect(screen.queryByTestId('rendered-markdown')).toBeNull();
    expect(screen.getByTestId('safe-preview-fallback')).toHaveTextContent('本文が長いので、プレビューは省きました。');
  });

  it('counts the emphasis and link marks', () => {
    expect(countEmphasisMarks('*a* _b_ ~~c~~ [d](e) plain')).toBe(9);
  });

  it('renders up to the emphasis-mark cap and falls back to the raw text one mark past it (MINOR-B)', () => {
    const atCap = 'a*'.repeat(SAFE_PREVIEW_MAX_MARKS);
    const view = render(<SafeMarkdownPreview text={atCap} />);
    expect(screen.getByTestId('rendered-markdown')).toBeInTheDocument();
    view.rerender(<SafeMarkdownPreview text={`${atCap}_`} />);
    expect(screen.queryByTestId('rendered-markdown')).toBeNull();
    expect(screen.getByTestId('safe-preview-fallback')).toHaveTextContent('強調やリンクの記号が多いので、プレビューは省きました。');
  });

  it('catches a render failure, shows the raw text, and tries again when the text changes', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<SafeMarkdownPreview text="BOOM body" />);
    expect(screen.getByTestId('safe-preview-fallback')).toHaveTextContent('プレビューを描けませんでした。');
    expect(screen.getByText('BOOM body')).toBeInTheDocument();
    view.rerender(<SafeMarkdownPreview text="fine body" />);
    expect(screen.getByTestId('rendered-markdown')).toHaveTextContent('fine body');
    consoleError.mockRestore();
  });
});
