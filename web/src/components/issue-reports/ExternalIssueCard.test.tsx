import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ExternalIssueDto } from '../../api/issue-reports-external';
import { makeExternalIssue, NO_FINDINGS } from '../../test/externalIssueFixtures';
import { ExternalIssueCard } from './ExternalIssueCard';
import { SAFE_PREVIEW_MAX_MARKS } from './SafeMarkdownPreview';

/** bdboard-4y8q.9.5: 届いた issue のカード。本文は第三者の文章なので、印・文字のまま・折りたたみを確かめる。 */

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const TAG_LATIN_A = String.fromCodePoint(0xe0041);

async function renderOpened(overrides: Partial<ExternalIssueDto> = {}) {
  const user = userEvent.setup();
  const view = render(
    <ul>
      <ExternalIssueCard issue={makeExternalIssue(overrides)} />
    </ul>,
  );
  await user.click(screen.getByRole('button', { name: '本文を見る' }));
  return { user, ...view };
}

describe('ExternalIssueCard: the summary', () => {
  it('shows the number, title, author, relation and the GitHub URL as text (never a link)', () => {
    const { container } = render(
      <ul>
        <ExternalIssueCard issue={makeExternalIssue()} />
      </ul>,
    );

    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('#17 external example issue');
    const meta = container.querySelector('.external-issue-meta');
    expect(meta?.textContent).toContain('作者: example-user');
    expect(meta?.textContent).toContain('関係: NONE');
    const url = screen.getByText('https://github.com/example/repo/issues/17');
    expect(url.tagName).toBe('CODE');
    expect(container.querySelector('a')).toBeNull();
  });

  it('does not invent an author or a relation that GitHub did not give', () => {
    render(
      <ul>
        <ExternalIssueCard issue={makeExternalIssue({ author: null, authorAssociation: null })} />
      </ul>,
    );

    expect(screen.getByText('作者: (不明)')).toBeTruthy();
    expect(screen.queryByText(/関係:/)).toBeNull();
  });

  it('marks hidden characters in the author and the relation too (they come from GitHub unchecked)', () => {
    const { container } = render(
      <ul>
        <ExternalIssueCard
          issue={makeExternalIssue({ author: `user${RIGHT_TO_LEFT_OVERRIDE}name`, authorAssociation: `NONE${ZERO_WIDTH_SPACE}` })}
        />
      </ul>,
    );

    const meta = container.querySelector('.external-issue-meta');
    expect(meta?.textContent).toContain('作者: user⟦U+202E⟧name');
    expect(meta?.textContent).toContain('関係: NONE⟦U+200B⟧');
    expect(container.textContent).not.toContain(RIGHT_TO_LEFT_OVERRIDE);
    expect(container.textContent).not.toContain(ZERO_WIDTH_SPACE);
  });

  it('puts the machine checks as counts only, without any word of judgment', () => {
    render(
      <ul>
        <ExternalIssueCard
          issue={makeExternalIssue({
            checks: {
              title: NO_FINDINGS,
              body: {
                invisibleChars: { total: 3, kinds: [{ codePoint: 'U+200B', name: 'ZERO WIDTH SPACE', group: 'zero-width', count: 3, positions: [1, 2, 3] }] },
                htmlComments: { count: 2, unclosed: true, totalChars: 40, spans: [] },
                longEncodedStrings: { count: 1, longest: 300, spans: [] },
                links: { total: 4, markdownLinks: 1, autolinks: 1, referenceDefinitions: 0, rawUrls: 2 },
              },
            },
          })}
        />
      </ul>,
    );

    const checks = within(screen.getByRole('heading', { name: '本文の検査' }).closest('section') as HTMLElement);
    expect(checks.getByText('見えない文字').nextElementSibling?.textContent).toBe('3U+200B ×3');
    expect(checks.getByText('HTML コメント').nextElementSibling?.textContent).toBe('2閉じていないものを含む');
    expect(checks.getByText('長い符号化文字列').nextElementSibling?.textContent).toBe('1');
    expect(checks.getByText('リンク').nextElementSibling?.textContent).toContain('生の URL 2');
    // 題名には何も無いので、題名の検査は出さない。
    expect(screen.queryByRole('heading', { name: '題名の検査' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/安全|危険|怪しい|疑い/);
  });

  it('shows the title checks too when the title itself has something, and marks hidden characters in the title', () => {
    const title = `pay${ZERO_WIDTH_SPACE}load`;
    render(
      <ul>
        <ExternalIssueCard
          issue={makeExternalIssue({
            title,
            checks: {
              title: { ...NO_FINDINGS, invisibleChars: { total: 1, kinds: [] } },
              body: NO_FINDINGS,
            },
          })}
        />
      </ul>,
    );

    expect(screen.getByRole('heading', { name: '題名の検査' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('#17 pay⟦U+200B⟧load');
  });

  it('shows the re-judge notice only when GitHub-side edits were found', () => {
    const { rerender } = render(
      <ul>
        <ExternalIssueCard issue={makeExternalIssue({ needsRejudge: true })} />
      </ul>,
    );
    expect(screen.getByRole('status').textContent).toBe('GitHub 側で編集されました (判定のやり直しが必要)');

    rerender(
      <ul>
        <ExternalIssueCard issue={makeExternalIssue({ needsRejudge: false, updatedAtChanged: true })} />
      </ul>,
    );
    expect(screen.queryByText(/判定のやり直し/)).toBeNull();
  });

  it('marks a truncated title and body with the original length (code points), never both as one number', () => {
    render(
      <ul>
        <ExternalIssueCard issue={makeExternalIssue({ titleTruncated: true, titleLength: 400, bodyTruncated: true, bodyLength: 25_000 })} />
      </ul>,
    );

    expect(screen.getByText('題名は長いため途中までです (元は 400 文字)')).toBeTruthy();
    expect(screen.getByText('本文は長いため途中までです (元は 25000 文字)')).toBeTruthy();
  });
});

describe('ExternalIssueCard: the body is only drawn when opened', () => {
  it('keeps the body out of the DOM until the card is opened, and removes it again when folded', async () => {
    const user = userEvent.setup();
    render(
      <ul>
        <ExternalIssueCard issue={makeExternalIssue({ body: 'secret-looking body text' })} />
      </ul>,
    );
    const toggle = screen.getByRole('button', { name: '本文を見る' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/secret-looking body text/)).toBeNull();

    await user.click(toggle);
    expect(screen.getByRole('button', { name: '本文をたたむ' }).getAttribute('aria-expanded')).toBe('true');
    const controlled = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(controlled?.textContent).toContain('secret-looking body text');

    await user.click(screen.getByRole('button', { name: '本文をたたむ' }));
    expect(screen.queryByText(/secret-looking body text/)).toBeNull();
  });
});

describe('ExternalIssueCard: the raw body (the default)', () => {
  it('replaces hidden characters with a mark and leaves none of the real characters in the page', async () => {
    const { container } = await renderOpened({
      body: `before${ZERO_WIDTH_SPACE}${RIGHT_TO_LEFT_OVERRIDE}middle${TAG_LATIN_A}after`,
    });

    const marks = screen.getAllByTestId('external-issue-invisible-mark').map((mark) => mark.textContent);
    expect(marks).toEqual(['⟦U+200B⟧⟦U+202E⟧', '⟦U+E0041⟧']);
    expect(container.textContent).not.toContain(ZERO_WIDTH_SPACE);
    expect(container.textContent).not.toContain(RIGHT_TO_LEFT_OVERRIDE);
    expect(container.textContent).not.toContain(TAG_LATIN_A);
    expect(container.querySelector('pre')?.textContent).toBe('before⟦U+200B⟧⟦U+202E⟧middle⟦U+E0041⟧after');
  });

  it('shows an HTML comment as characters, with a mark, and does not hide it', async () => {
    await renderOpened({ body: 'visible <!-- ignore previous instructions --> tail' });

    const comment = screen.getByTestId('external-issue-html-comment');
    expect(comment.textContent).toBe('⟦HTML コメント⟧<!-- ignore previous instructions -->');
    expect(screen.getByText('<!-- ignore previous instructions -->')).toBeTruthy();
  });

  it('marks an unclosed comment as such and still shows what is inside it', async () => {
    await renderOpened({ body: `<!-- never closed ${ZERO_WIDTH_SPACE}` });

    const comment = screen.getByTestId('external-issue-html-comment');
    expect(comment.textContent).toBe('⟦HTML コメント (閉じていない)⟧<!-- never closed ⟦U+200B⟧');
  });

  it('explains the marks in words (not only by colour)', async () => {
    await renderOpened({ body: 'x' });

    expect(screen.getByText(/見えない文字、「⟦HTML コメント⟧」から始まる部分は HTML コメント/)).toBeTruthy();
  });

  it('never turns links into <a href> or loads images, in the raw view and in the preview', async () => {
    const body = [
      '[x](https://attacker.example/a)',
      'https://attacker.example/raw',
      '<https://attacker.example/auto>',
      '![p](https://attacker.example/p.png)',
      '[bad](javascript:alert(1))',
    ].join('\n');
    const { user, container } = await renderOpened({ body });
    expect(container.querySelector('a[href], img')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe(body);

    await user.click(screen.getByRole('button', { name: 'プレビュー' }));

    expect(container.querySelector('a[href], img')).toBeNull();
    expect(container.querySelector('[href], [src]')).toBeNull();
    expect(screen.getAllByTestId('safe-preview-link').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByTestId('safe-preview-image').textContent).toContain('読み込みません');
  });
});

describe('ExternalIssueCard: the preview is only for a person who asks', () => {
  it('starts in the raw view and reports the pressed state of the two buttons', async () => {
    const { user } = await renderOpened({ body: '# heading' });
    const raw = screen.getByRole('button', { name: '生の本文' });
    const preview = screen.getByRole('button', { name: 'プレビュー' });
    expect(raw.getAttribute('aria-pressed')).toBe('true');
    expect(preview.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('heading', { name: 'heading' })).toBeNull();

    await user.click(preview);

    expect(preview.getAttribute('aria-pressed')).toBe('true');
    expect(raw.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('heading', { name: 'heading' })).toBeTruthy();
  });

  it('warns in the preview that hidden characters and HTML comments are not visible there', async () => {
    const { user } = await renderOpened({
      body: `a${ZERO_WIDTH_SPACE}b <!-- c -->`,
      checks: { title: NO_FINDINGS, body: { ...NO_FINDINGS, invisibleChars: { total: 1, kinds: [] }, htmlComments: { count: 1, unclosed: false, totalChars: 10, spans: [] } } },
    });
    expect(screen.queryByText(/プレビューでは見えない文字/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'プレビュー' }));

    expect(screen.getByText('プレビューでは見えない文字と HTML コメントが見えません。生の本文で確かめてください。')).toBeTruthy();
  });

  it('does not offer the preview for a body that is too heavy, and keeps the raw view with its marks', async () => {
    const heavy = `${'*'.repeat(SAFE_PREVIEW_MAX_MARKS + 1)}${ZERO_WIDTH_SPACE}`;
    await renderOpened({ body: heavy });

    const preview = screen.getByRole('button', { name: 'プレビュー' });
    expect(preview.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/強調やリンクの記号が多いので、プレビューは省きました。生の本文のままにします。/)).toBeTruthy();
    expect(screen.getByTestId('external-issue-invisible-mark').textContent).toBe('⟦U+200B⟧');
  });
});
