import { describe, expect, it } from 'vitest';
import {
  findDetectableNounSpans,
  findProjectRootSpans,
  findReplaceableNounSpans,
  prepareKeys,
} from './issue-public-keys.js';
import type { LocalProperNoun } from './issue-public-types.js';

function texts(text: string, spans: readonly { start: number; end: number }[]): string[] {
  return spans.map((span) => text.slice(span.start, span.end));
}

const noun = (category: LocalProperNoun['category'], value: string): LocalProperNoun => ({ category, value });

describe('project roots', () => {
  const prepared = prepareKeys({ projectRoots: ['/work/example-project/'], properNouns: [] });

  it.each([
    ['slashes', '/work/example-project/src', '/work/example-project'],
    ['backslashes', '\\work\\example-project\\src', '\\work\\example-project'],
    ['JSON-escaped backslashes', '\\\\work\\\\example-project\\\\src', '\\\\work\\\\example-project'],
    ['upper case', '/WORK/Example-Project/src', '/WORK/Example-Project'],
  ])('matches the root written with %s', (_name, text, expected) => {
    expect(texts(text, findProjectRootSpans(text, prepared))).toEqual([expected]);
  });

  it('matches a Windows root in any separator style', () => {
    const windows = prepareKeys({ projectRoots: ['C:\\work\\example-project'], properNouns: [] });
    for (const text of ['C:\\work\\example-project\\a', 'C:/work/example-project/a', 'C:\\\\work\\\\example-project\\\\a']) {
      expect(findProjectRootSpans(text, windows)).toHaveLength(1);
    }
  });

  it('matches a root written in a different Unicode normalization form', () => {
    const japanese = prepareKeys({ projectRoots: ['/work/ガイド'], properNouns: [] });
    expect(findProjectRootSpans('/work/' + 'ガイド'.normalize('NFD') + '/x', japanese)).toHaveLength(1);
    expect(findProjectRootSpans('/work/' + 'ガイド'.normalize('NFC') + '/x', japanese)).toHaveLength(1);
  });

  it.each(['/work/example-project2/src', '/work/example-project_x', '/work/example-project-b', '/work/example-projectあ'])(
    'does not match a different name that merely starts with the root: %s',
    (text) => {
      expect(findProjectRootSpans(text, prepared)).toEqual([]);
    },
  );

  it('matches the root at the end of the text and before punctuation', () => {
    expect(findProjectRootSpans('cwd=/work/example-project', prepared)).toHaveLength(1);
    expect(findProjectRootSpans('"/work/example-project":1', prepared)).toHaveLength(1);
    expect(findProjectRootSpans('/work/example-project.git', prepared)).toHaveLength(1);
  });

  it.each(['/', '//', 'C:\\', 'C:', '', '   ', '/a', 'ab/'])('ignores a root that is too short or only separators: %j', (root) => {
    const empty = prepareKeys({ projectRoots: [root], properNouns: [] });
    expect(findProjectRootSpans('/ C:\\ // a ab', empty)).toEqual([]);
  });
});

describe('proper nouns', () => {
  it('replaces and detects long nouns by case-insensitive substring', () => {
    const prepared = prepareKeys({ projectRoots: [], properNouns: [noun('project', 'ExampleProject')] });
    const text = 'xx exampleproject yy EXAMPLEPROJECT zz myExampleProjectfoo';
    expect(texts(text, findReplaceableNounSpans(text, prepared))).toEqual([
      'exampleproject',
      'EXAMPLEPROJECT',
      'ExampleProject',
    ]);
    expect(findDetectableNounSpans(text, prepared)).toHaveLength(3);
    expect(findReplaceableNounSpans(text, prepared).every((span) => span.kind === 'project')).toBe(true);
  });

  it('matches across NFC and NFD forms in both directions', () => {
    const composed = prepareKeys({ projectRoots: [], properNouns: [noun('user', 'ガイド担当')] });
    const decomposedText = 'ガイド担当'.normalize('NFD');
    expect(findReplaceableNounSpans(decomposedText, composed)).toHaveLength(1);
    const decomposed = prepareKeys({ projectRoots: [], properNouns: [noun('user', 'ガイド担当'.normalize('NFD'))] });
    expect(findReplaceableNounSpans('ガイド担当'.normalize('NFC'), decomposed)).toHaveLength(1);
  });

  it('treats regular expression metacharacters in a noun literally', () => {
    const prepared = prepareKeys({ projectRoots: [], properNouns: [noun('branch', 'feat/a.b+c(1)[x]'), noun('host', 'a|b$^*?')] });
    const text = 'feat/a.b+c(1)[x] featXa.b+c(1)[x] a|b$^*?';
    expect(texts(text, findReplaceableNounSpans(text, prepared))).toEqual(['feat/a.b+c(1)[x]', 'a|b$^*?']);
  });

  it('detects short nouns (2-3 code points) only as whole words and never replaces them', () => {
    const prepared = prepareKeys({ projectRoots: [], properNouns: [noun('host', 'tom'), noun('user', 'ab')] });
    const text = 'tom custom tom, (ab) abc tomato Ab';
    expect(findReplaceableNounSpans(text, prepared)).toEqual([]);
    expect(texts(text, findDetectableNounSpans(text, prepared))).toEqual(['tom', 'tom', 'ab', 'Ab']);
  });

  it('applies the word boundary to non-ASCII letters too', () => {
    const prepared = prepareKeys({ projectRoots: [], properNouns: [noun('user', '太郎')] });
    expect(findDetectableNounSpans('太郎', prepared)).toHaveLength(1);
    expect(findDetectableNounSpans('大太郎です 太郎。', prepared)).toHaveLength(1);
  });

  it.each([
    ['one character', 'x'],
    ['empty', ''],
    ['blank', '   '],
    ['invisible only', String.fromCodePoint(0x200b)],
    ['stoplist main', 'main'],
    ['stoplist master (case-insensitive)', 'MASTER'],
    ['stoplist develop', 'develop'],
    ['stoplist trunk', 'trunk'],
    ['stoplist head', 'HEAD'],
    ['stoplist root', 'root'],
    ['stoplist localhost', 'localhost'],
  ])('ignores %s', (_name, value) => {
    const prepared = prepareKeys({ projectRoots: [], properNouns: [noun('branch', value)] });
    expect(findDetectableNounSpans('x main MASTER develop trunk HEAD root localhost', prepared)).toEqual([]);
  });

  it('ignores a noun longer than 512 code points and caps the list at 200 nouns', () => {
    const tooLong = 'z'.repeat(513);
    const prepared = prepareKeys({ projectRoots: [], properNouns: [noun('user', tooLong)] });
    expect(findDetectableNounSpans(tooLong, prepared)).toEqual([]);
    const many = Array.from({ length: 205 }, (_, index) => noun('user', `name-${String(index).padStart(3, '0')}`));
    const capped = prepareKeys({ projectRoots: [], properNouns: many });
    expect(findDetectableNounSpans('name-199', capped)).toHaveLength(1);
    expect(findDetectableNounSpans('name-200', capped)).toEqual([]);
  });

  it('keeps the same value in two categories as two keys and dedupes identical ones', () => {
    const prepared = prepareKeys({
      projectRoots: [],
      properNouns: [noun('user', 'Example'), noun('user', 'example'), noun('host', 'example')],
    });
    const kinds = findReplaceableNounSpans('example', prepared).map((span) => span.kind);
    expect(kinds.sort()).toEqual(['host', 'user']);
  });

  it('is deterministic regardless of the host locale (no locale-dependent case mapping)', () => {
    const prepared = prepareKeys({ projectRoots: [], properNouns: [noun('user', 'TITLE-EXAMPLE')] });
    expect(findReplaceableNounSpans('title-example', prepared)).toHaveLength(1);
  });
});
