import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SafeMarkdownPreview } from './SafeMarkdownPreview';

// docs/ISSUE-REPORTING.md 5節「プレビュー表示時の注意」: 描いただけで外へリクエストが飛ばないこと。
describe('SafeMarkdownPreview (bdboard-4y8q.3.2)', () => {
  it('shows a markdown image as text and never renders an <img>', () => {
    const { container } = render(
      <SafeMarkdownPreview text={'before ![pixel](https://attacker.example/pixel.png?id=1) after'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    const image = screen.getByTestId('safe-preview-image');
    expect(image).toHaveTextContent('画像: pixel');
    expect(image).toHaveTextContent('https://attacker.example/pixel.png?id=1');
    expect(image).toHaveTextContent('読み込みません');
  });

  it('does not render raw HTML images or anchors from the body', () => {
    const { container } = render(
      <SafeMarkdownPreview text={'<img src="https://attacker.example/a.png">\n\n<a href="https://attacker.example">x</a>'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('shows links (inline, reference and autolinks) as text with their target, without an href to follow', () => {
    const text = [
      '[docs](https://example.com/docs)',
      '',
      'see https://example.com/auto',
      '',
      '[ref][r]',
      '',
      '[r]: https://example.com/ref',
      '',
      '![ref image][i]',
      '',
      '[i]: https://example.com/i.png',
    ].join('\n');
    const { container } = render(<SafeMarkdownPreview text={text} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
    expect(container.querySelector('[src]')).toBeNull();
    const links = screen.getAllByTestId('safe-preview-link');
    expect(links.map((link) => link.textContent)).toEqual([
      'docs <https://example.com/docs>',
      'https://example.com/auto <https://example.com/auto>',
      'ref <https://example.com/ref>',
    ]);
    expect(screen.getByTestId('safe-preview-image')).toHaveTextContent('https://example.com/i.png');
  });

  it('keeps a javascript: URL as inert text', () => {
    const { container } = render(<SafeMarkdownPreview text={'[x](javascript:alert(1))'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByTestId('safe-preview-link')).toHaveTextContent('javascript:alert(1)');
  });

  it('still renders ordinary GitHub markdown (headings, code, tables)', () => {
    render(<SafeMarkdownPreview text={'## 症状\n\n`code`\n\n| a | b |\n|---|---|\n| 1 | 2 |'} />);
    expect(screen.getByRole('heading', { name: '症状' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('code').tagName).toBe('CODE');
  });
});
