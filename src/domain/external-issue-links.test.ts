import { describe, expect, it } from 'vitest';
import { countLinks, type LinkCheck } from './external-issue-links.js';

const links = (markdownLinks: number, autolinks: number, referenceDefinitions: number, rawUrls: number): LinkCheck => ({
  total: markdownLinks + autolinks + referenceDefinitions + rawUrls,
  markdownLinks,
  autolinks,
  referenceDefinitions,
  rawUrls,
});

describe('countLinks: one kind at a time', () => {
  it('counts a Markdown link, and an image the same way', () => {
    expect(countLinks('[docs](https://docs.example/start)')).toEqual(links(1, 0, 0, 0));
    expect(countLinks('![screenshot](https://img.example/a.png)')).toEqual(links(1, 0, 0, 0));
    expect(countLinks('[a](/relative/path) and [b](#anchor) and [c]()')).toEqual(links(3, 0, 0, 0));
  });

  it('counts a link with a title, brackets in its text, and parentheses in its destination', () => {
    expect(countLinks('[a](https://x.example "title")')).toEqual(links(1, 0, 0, 0));
    expect(countLinks('[a [b] c](https://x.example)')).toEqual(links(1, 0, 0, 0));
    expect(countLinks('[w](https://en.wikipedia.example/wiki/Foo_(bar))')).toEqual(links(1, 0, 0, 0));
  });

  it('counts an autolink with any scheme, and not an email address or plain angle brackets', () => {
    expect(countLinks('<https://x.example/p?q=1>')).toEqual(links(0, 1, 0, 0));
    expect(countLinks('<mailto:someone@x.example>')).toEqual(links(0, 1, 0, 0));
    expect(countLinks('<ftp://x.example/file>')).toEqual(links(0, 1, 0, 0));
    expect(countLinks('<someone@x.example> <not a link> <b> <a:b>')).toEqual(links(0, 0, 0, 0));
  });

  it('counts a reference definition, and not the places that use it', () => {
    expect(countLinks('[1]: https://x.example "title"')).toEqual(links(0, 0, 1, 0));
    expect(countLinks('[ref]: /relative')).toEqual(links(0, 0, 1, 0));
    expect(countLinks('   [indented]: https://x.example')).toEqual(links(0, 0, 1, 0));
    expect(countLinks('text [use][1] and [1]\n\n[1]: https://x.example')).toEqual(links(0, 0, 1, 0));
    expect(countLinks('[a]: https://a.example\n[b]: https://b.example\n[c]: https://c.example')).toEqual(links(0, 0, 3, 0));
  });

  it('does not count a footnote, a definition with no destination, a too-deep indent, or a definition in the middle of a line', () => {
    expect(countLinks('[^1]: a footnote')).toEqual(links(0, 0, 0, 0));
    expect(countLinks('[x]:')).toEqual(links(0, 0, 0, 0));
    expect(countLinks('[x]:   \nnext line')).toEqual(links(0, 0, 0, 0));
    expect(countLinks('    [indented4]: /code-block')).toEqual(links(0, 0, 0, 0));
    expect(countLinks('text [x]: /path')).toEqual(links(0, 0, 0, 0));
  });

  it('counts a raw URL of http and https, in any case, and not other schemes or a scheme-less host', () => {
    expect(countLinks('see https://a.example and http://b.example/x?y=1.')).toEqual(links(0, 0, 0, 2));
    expect(countLinks('HTTPS://A.EXAMPLE and Http://B.example')).toEqual(links(0, 0, 0, 2));
    expect(countLinks('ftp://x.example www.example.com example.com/path https:// http:/x')).toEqual(links(0, 0, 0, 0));
    expect(countLinks('(https://a.example)')).toEqual(links(0, 0, 0, 1));
  });

  it('returns zero for text without links and for empty text', () => {
    expect(countLinks('')).toEqual(links(0, 0, 0, 0));
    expect(countLinks('just words, [brackets] and (parentheses) and <tags>')).toEqual(links(0, 0, 0, 0));
  });
});

describe('countLinks: the same URL is not counted twice', () => {
  it('counts a URL in the text of a Markdown link, and one repeated in its destination, once', () => {
    expect(countLinks('[https://x.example](https://x.example)')).toEqual(links(1, 0, 0, 0));
    expect(countLinks('[https://x.example/a](https://y.example/b)')).toEqual(links(1, 0, 0, 0));
  });

  it('counts a URL inside an autolink once', () => {
    expect(countLinks('<https://x.example>')).toEqual(links(0, 1, 0, 0));
  });

  it('counts a URL in a reference definition once', () => {
    expect(countLinks('[1]: https://x.example')).toEqual(links(0, 0, 1, 0));
    expect(countLinks('[1]: <https://x.example> "https://y.example/title"')).toEqual(links(0, 0, 1, 1));
  });

  it('counts an autolink inside the text of a Markdown link once', () => {
    expect(countLinks('[<https://x.example>](https://y.example)')).toEqual(links(1, 0, 0, 0));
  });

  it('counts each separate place in the text, even when two places hold the same URL', () => {
    expect(countLinks('[a](https://x.example) then https://x.example')).toEqual(links(1, 0, 0, 1));
    expect(countLinks('https://x.example https://x.example')).toEqual(links(0, 0, 0, 2));
  });

  it('counts a mix of all four with the breakdown, and the total is the sum of it', () => {
    const text = [
      'Intro [one](https://a.example) and ![two](https://b.example/i.png).',
      'Also <https://c.example>, see [ref] and https://d.example/x.',
      '',
      '[ref]: https://e.example',
    ].join('\n');
    expect(countLinks(text)).toEqual(links(2, 1, 1, 1));
  });

  it('counts the inner image and the outer link of a linked image as two', () => {
    expect(countLinks('[![logo](https://i.example/logo.png)](https://home.example)')).toEqual(links(2, 0, 0, 0));
  });
});

describe('countLinks: what is not a link', () => {
  it('does not count a link whose brackets are escaped, but still counts the URL as a raw URL', () => {
    expect(countLinks(String.raw`\[a\](https://x.example)`)).toEqual(links(0, 0, 0, 1));
  });

  it('does not count a link with a space between the text and the destination', () => {
    expect(countLinks('[a] (/path)')).toEqual(links(0, 0, 0, 0));
  });

  it('does not count a destination that is not closed on its own line', () => {
    expect(countLinks('[a](https://x.example')).toEqual(links(0, 0, 0, 1));
    expect(countLinks('[a](https://x.example\nmore)')).toEqual(links(0, 0, 0, 1));
  });

  it('does not start a link inside a destination', () => {
    // 宛先の中の [b](c) は、外のリンクの一部として読み飛ばす。
    expect(countLinks('[a](x[b](c)')).toEqual(links(1, 0, 0, 0));
  });

  it('does not read code context: a link inside backticks is counted too (the check only counts)', () => {
    expect(countLinks('`[a](https://x.example)`')).toEqual(links(1, 0, 0, 0));
  });
});
