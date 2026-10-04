import { describe, expect, it } from 'vitest';
import { codeBlock, codeSpan } from './issue-public-markdown.js';

/** CommonMark のコードスパンとして読み戻す: 開きと閉じが同じ長さの連で、中身にその長さの連が無いこと。 */
function parseCodeSpan(markup: string): string {
  const open = /^`+/.exec(markup)?.[0] ?? '';
  const close = /`+$/.exec(markup)?.[0] ?? '';
  expect(open.length).toBeGreaterThan(0);
  expect(close).toBe(open);
  let content = markup.slice(open.length, markup.length - close.length);
  for (const run of content.match(/`+/g) ?? []) expect(run.length).not.toBe(open.length);
  if (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') content = content.slice(1, -1);
  return content;
}

/** CommonMark のフェンス付きコードブロックとして読み戻す: 閉じは開き以上の長さのバッククォートだけの行。 */
function parseCodeBlock(markup: string): string {
  const lines = markup.split('\n');
  const opening = /^(`{3,})text$/.exec(lines[0] ?? '');
  expect(opening).not.toBeNull();
  const fence = opening?.[1] ?? '';
  expect(lines.at(-1)).toBe(fence);
  const body = lines.slice(1, -1);
  const closing = new RegExp(`^ {0,3}\`{${String(fence.length)},}[ \\t]*$`);
  for (const line of body) expect(closing.test(line)).toBe(false);
  return body.join('\n');
}

describe('codeSpan', () => {
  it('keeps active Markdown-like inline text entirely inside one code span', () => {
    const content =
      '[x](http://example.com) @example-user #123 example-owner/example-repo#1 <img src=x onerror=1> <!-- c --> # not a heading';
    const piece = codeSpan({ text: content, marks: [] });
    expect(piece.text).toBe(`\`${content}\``);
    expect(parseCodeSpan(piece.text)).toBe(content);
  });

  it.each([1, 2, 3, 4, 5, 6])('survives a run of %i backticks at the start, the end and the middle', (length) => {
    const run = '`'.repeat(length);
    for (const content of [`${run}tail`, `head${run}`, `a${run}b`, `${run}`, `x${run}y${run}z`]) {
      const piece = codeSpan({ text: content, marks: [] });
      expect(parseCodeSpan(piece.text)).toBe(content);
      const delimiter = /^`+/.exec(piece.text)?.[0] ?? '';
      expect(delimiter.length).toBeGreaterThan(length);
    }
  });

  it('survives mixed run lengths and pads only when the content touches the delimiter', () => {
    const content = 'a`b``c```d````e`````f``````g';
    expect(codeSpan({ text: content, marks: [] }).text).toBe(`${'`'.repeat(7)}${content}${'`'.repeat(7)}`);
    expect(codeSpan({ text: '`a', marks: [] }).text).toBe('`` `a ``');
    expect(codeSpan({ text: 'a`', marks: [] }).text).toBe('`` a` ``');
  });

  it('shifts the marks by the length of the opening delimiter (and padding)', () => {
    const plain = codeSpan({ text: 'ab<user>', marks: [{ kind: 'user', start: 2, end: 8 }] });
    expect(plain.text.slice(plain.marks[0]?.start, plain.marks[0]?.end)).toBe('<user>');
    const padded = codeSpan({ text: '`<user>', marks: [{ kind: 'user', start: 1, end: 7 }] });
    expect(padded.text.slice(padded.marks[0]?.start, padded.marks[0]?.end)).toBe('<user>');
  });
});

describe('codeBlock', () => {
  it('wraps multi-line content in a fence of at least three backticks with a text info string', () => {
    const piece = codeBlock({ text: 'line 1\nline 2', marks: [] });
    expect(piece.text).toBe('```text\nline 1\nline 2\n```');
    expect(parseCodeBlock(piece.text)).toBe('line 1\nline 2');
  });

  it.each([1, 2, 3, 4, 5, 6])('uses a fence longer than a %i-backtick run, on its own line and inline', (length) => {
    const run = '`'.repeat(length);
    for (const content of [`line\n${run}\nend`, `a${run}b`, `${run}\n${run}`, `  ${run}`, `${run}text`]) {
      const piece = codeBlock({ text: content, marks: [] });
      expect(parseCodeBlock(piece.text)).toBe(content);
      expect(piece.text.startsWith('`'.repeat(Math.max(3, length + 1)) + 'text\n')).toBe(true);
    }
  });

  it('keeps tildes, headings, HTML comments, links and html inside the block', () => {
    const content = '~~~\n# heading\n<!-- x -->\n[a](http://example.com)\n<img src=x>\n> quote\n@example-user #1';
    const piece = codeBlock({ text: content, marks: [] });
    expect(parseCodeBlock(piece.text)).toBe(content);
    expect(piece.text.startsWith('```text\n')).toBe(true);
  });

  it('shifts the marks by the length of the opening line', () => {
    const piece = codeBlock({ text: 'x <host> y', marks: [{ kind: 'host', start: 2, end: 8 }] });
    expect(piece.text.slice(piece.marks[0]?.start, piece.marks[0]?.end)).toBe('<host>');
  });
});
