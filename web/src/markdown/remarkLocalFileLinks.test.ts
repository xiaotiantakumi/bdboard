import { describe, expect, it } from 'vitest';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Root } from 'mdast';
import {
  localFilePathFromUrl,
  localFileUrl,
  matchLocalFilePath,
  remarkLocalFileLinks,
  splitTextByLocalFiles,
} from './remarkLocalFileLinks';

const PATHS = ['out/foo/final.mp4', 'out/foo', 'docs/notes.md'];

function run(markdown: string, paths: readonly string[] = PATHS): Root {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkLocalFileLinks, paths);
  return processor.runSync(processor.parse(markdown)) as Root;
}

function linkPaths(tree: Root): string[] {
  const found: string[] = [];
  const walk = (node: { type: string; url?: string; children?: unknown[] }) => {
    if (node.type === 'link' && node.url !== undefined) {
      const path = localFilePathFromUrl(node.url);
      if (path !== undefined) found.push(path);
    }
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk(tree);
  return found;
}

describe('matchLocalFilePath', () => {
  it('matches exact paths, ./ prefixes and trailing slashes', () => {
    expect(matchLocalFilePath('out/foo/final.mp4', PATHS)).toBe('out/foo/final.mp4');
    expect(matchLocalFilePath('./out/foo/final.mp4', PATHS)).toBe('out/foo/final.mp4');
    expect(matchLocalFilePath('out/foo/', PATHS)).toBe('out/foo');
  });

  it('matches a relative tail of a resolved path on a segment boundary only', () => {
    expect(matchLocalFilePath('foo/final.mp4', PATHS)).toBe('out/foo/final.mp4');
    expect(matchLocalFilePath('final.mp4', PATHS)).toBe('out/foo/final.mp4');
    expect(matchLocalFilePath('o/final.mp4', ['out/final.mp4'])).toBeUndefined();
  });

  it('ignores tokens that are not resolved files or look like plain words', () => {
    expect(matchLocalFilePath('missing/file.mp4', PATHS)).toBeUndefined();
    expect(matchLocalFilePath('notes', ['docs/notes'])).toBeUndefined();
    expect(matchLocalFilePath('', PATHS)).toBeUndefined();
  });
});

describe('splitTextByLocalFiles', () => {
  it('splits around a path and drops trailing punctuation from the link', () => {
    expect(splitTextByLocalFiles('動画を確認して: out/foo/final.mp4.', PATHS)).toEqual([
      { text: '動画を確認して: ' },
      { text: 'out/foo/final.mp4', path: 'out/foo/final.mp4' },
      { text: '.' },
    ]);
  });

  it('returns null when nothing resolves and skips ~-prefixed tokens', () => {
    expect(splitTextByLocalFiles('nothing here', PATHS)).toBeNull();
    expect(splitTextByLocalFiles('~out/foo/final.mp4', PATHS)).toBeNull();
  });
});

describe('remarkLocalFileLinks', () => {
  it('links text paths and inline code paths', () => {
    const tree = run('見て: out/foo/final.mp4 と `docs/notes.md` と out/foo/');
    expect(linkPaths(tree)).toEqual(['out/foo/final.mp4', 'docs/notes.md', 'out/foo']);
  });

  it('does not touch unresolved paths, code blocks or existing links', () => {
    const tree = run(
      ['missing/x.mp4', '', '```', 'out/foo/final.mp4', '```', '', '[out/foo/final.mp4](https://example.com)'].join('\n'),
    );
    expect(linkPaths(tree)).toEqual([]);
  });

  it('is a no-op without resolved files', () => {
    expect(linkPaths(run('out/foo/final.mp4', []))).toEqual([]);
  });

  it('round-trips the url encoding', () => {
    expect(localFilePathFromUrl(localFileUrl('a b/c.md'))).toBe('a b/c.md');
    expect(localFilePathFromUrl('https://example.com')).toBeUndefined();
  });
});
