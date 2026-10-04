import { describe, expect, it } from 'vitest';
import {
  MAX_NOUNS,
  MAX_ROOTS,
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
    const spans = [...findReplaceableNounSpans(text, prepared)].sort((left, right) => left.start - right.start);
    expect(texts(text, spans)).toEqual(['feat/a.b+c(1)[x]', 'a|b$^*?']);
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

describe('the cap on proper nouns is tiered, deduplicated and never silent', () => {
  const unique = (count: number, category: LocalProperNoun['category'], prefix: string): LocalProperNoun[] =>
    Array.from({ length: count }, (_, index) => noun(category, `${prefix}-${String(index).padStart(3, '0')}`));
  /** 2〜3 コードポイントの名前を重ならずに作る ("b00" … "b5j")。 */
  const shortName = (index: number): string => `b${index.toString(36).padStart(2, '0')}`;

  it('counts duplicates once: 200 copies of one project name leave room for the user name', () => {
    const copies = Array.from({ length: 200 }, () => noun('project', 'example-project'));
    const prepared = prepareKeys({ projectRoots: [], properNouns: [...copies, noun('user', 'example-user')] });
    expect(prepared.truncated).toBe(false);
    expect(findReplaceableNounSpans('example-project example-user', prepared)).toHaveLength(2);
  });

  it('dedupes by category and case-insensitively, but keeps the same spelling under two categories', () => {
    const prepared = prepareKeys({
      projectRoots: [],
      properNouns: [noun('user', 'Example-Name'), noun('user', 'example-name'), noun('host', 'EXAMPLE-NAME')],
    });
    expect(prepared.replaceableNouns.map(({ kind }) => kind).sort()).toEqual(['host', 'user']);
  });

  it('keeps the long user name when 200 short names come first, and says so', () => {
    const shorts = Array.from({ length: 200 }, (_, index) => noun('branch', shortName(index)));
    const prepared = prepareKeys({ projectRoots: [], properNouns: [...shorts, noun('user', 'example-user')] });
    expect(prepared.truncated).toBe(true);
    expect(findReplaceableNounSpans('by example-user', prepared)).toHaveLength(1);
    expect(findDetectableNounSpans(shortName(0), prepared)).toHaveLength(1);
    expect(findDetectableNounSpans(shortName(198), prepared)).toHaveLength(1);
    expect(findDetectableNounSpans(shortName(199), prepared)).toEqual([]);
  });

  it('drops branch names before project, user and host names, and short names before branch names', () => {
    const tierOne = [...unique(100, 'project', 'proj'), ...unique(99, 'user', 'user'), noun('host', 'example-host')];
    const prepared = prepareKeys({
      projectRoots: [],
      properNouns: [noun('user', 'ab'), noun('branch', 'feature-one'), noun('branch', 'feature-two'), ...tierOne],
    });
    expect(prepared.truncated).toBe(true);
    const found = (value: string): number => findDetectableNounSpans(value, prepared).length;
    expect(found('example-host')).toBe(1);
    expect(found('proj-099')).toBe(1);
    expect(found('feature-one')).toBe(0);
    expect(found('feature-two')).toBe(0);
    expect(found('ab')).toBe(0);
  });

  it('fills the remaining room by tier: after 198 tier-1 names, both branches fit and the short name does not', () => {
    const prepared = prepareKeys({
      projectRoots: [],
      properNouns: [noun('user', 'ab'), noun('branch', 'feature-one'), noun('branch', 'feature-two'), ...unique(198, 'project', 'proj')],
    });
    expect(prepared.truncated).toBe(true);
    expect(findDetectableNounSpans('feature-one', prepared)).toHaveLength(1);
    expect(findDetectableNounSpans('feature-two', prepared)).toHaveLength(1);
    expect(findDetectableNounSpans('ab', prepared)).toEqual([]);
  });

  it('does not flag the list as truncated at exactly 200 names, or for names that are ignored on purpose', () => {
    expect(prepareKeys({ projectRoots: [], properNouns: unique(200, 'user', 'name') }).truncated).toBe(false);
    const ignored = prepareKeys({
      projectRoots: [],
      properNouns: [noun('user', 'x'), noun('user', ''), noun('branch', 'main'), noun('branch', 'MASTER'), noun('host', 'localhost')],
    });
    expect(ignored.truncated).toBe(false);
  });

  it('flags a name over 512 code points, a root over 1024 code points and a 201st root', () => {
    expect(prepareKeys({ projectRoots: [], properNouns: [noun('user', 'z'.repeat(513))] }).truncated).toBe(true);
    expect(prepareKeys({ projectRoots: [`/${'z'.repeat(1_100)}`], properNouns: [] }).truncated).toBe(true);
    const roots = Array.from({ length: 201 }, (_, index) => `/work/project-${String(index).padStart(3, '0')}`);
    const prepared = prepareKeys({ projectRoots: roots, properNouns: [] });
    expect(prepared.truncated).toBe(true);
    expect(findProjectRootSpans('/work/project-199/x', prepared)).toHaveLength(1);
    expect(findProjectRootSpans('/work/project-200/x', prepared)).toEqual([]);
  });

  it('also dedupes roots (the same root written 300 times counts once)', () => {
    const roots = Array.from({ length: 300 }, () => '/work/example-project/');
    expect(prepareKeys({ projectRoots: roots, properNouns: [] }).truncated).toBe(false);
  });

  it('exports the limits the docs promise', () => {
    expect(MAX_NOUNS).toBe(200);
    expect(MAX_ROOTS).toBe(200);
  });
});

describe('percent-encoded names (Node prints file:/// URLs for ESM stack traces)', () => {
  const japanese = '仕事のアプリ';

  it.each([
    ['a space', 'my example app', 'at file:///work/my%20example%20app/x.mjs:1:1', 'my%20example%20app'],
    ['Japanese', japanese, `at file:///work/${encodeURIComponent(japanese)}/x.mjs:1:1`, encodeURIComponent(japanese)],
    ['Japanese in lower-case hex', japanese, `at file:///work/${encodeURIComponent(japanese).toLowerCase()}/x`, encodeURIComponent(japanese).toLowerCase()],
    ['a slash (encodeURIComponent form)', 'feat/my branch', 'ref=feat%2Fmy%20branch', 'feat%2Fmy%20branch'],
    ['a slash (encodeURI form)', 'feat/my branch', 'ref=feat/my%20branch', 'feat/my%20branch'],
    ['a non-ASCII Latin letter', 'ä-app-name', 'at %C3%A4-app-name', '%C3%A4-app-name'],
    ['a non-ASCII Latin letter in lower-case hex', 'ä-app-name', 'at %c3%a4-app-name', '%c3%a4-app-name'],
  ])('finds a noun written with %s', (_name, value, text, expected) => {
    const prepared = prepareKeys({ projectRoots: [], properNouns: [noun('project', value)] });
    expect(texts(text, findReplaceableNounSpans(text, prepared))).toEqual([expected]);
    expect(findDetectableNounSpans(text, prepared)).toHaveLength(1);
  });

  it('finds a project root written with %20 and with a Japanese folder name, in either hex case', () => {
    const spaced = prepareKeys({ projectRoots: ['/work/my proj'], properNouns: [] });
    const spacedText = 'at file:///work/my%20proj/x.mjs';
    expect(texts(spacedText, findProjectRootSpans(spacedText, spaced))).toEqual(['/work/my%20proj']);
    const root = prepareKeys({ projectRoots: ['/work/仕事'], properNouns: [] });
    const encoded = `file:///work/${encodeURIComponent('仕事')}/x`;
    expect(findProjectRootSpans(encoded, root)).toHaveLength(1);
    expect(findProjectRootSpans(encoded.toLowerCase(), root)).toHaveLength(1);
  });
});

describe('the folder name of a project root is a project name too', () => {
  it.each([
    ['a Windows root seen through WSL', 'C:\\Users\\jdoe\\work\\example-project', 'at /mnt/c/Users/jdoe/work/example-project/x'],
    ['mixed separators', 'C:\\Users\\jdoe\\work\\example-project', 'at C:\\Users\\jdoe\\work/example-project/x'],
    ['JSON-escaped slashes', '/work/example-project', '{"p":"\\/work\\/example-project\\/x"}'],
    ['a symlinked prefix', '/var/work/example-project', 'at /private/var/work/example-project/x'],
    ['a trailing slash', '/work/example-project/', 'in example-project now'],
  ])('replaces the folder name in %s', (_name, root, text) => {
    const prepared = prepareKeys({ projectRoots: [root], properNouns: [] });
    const spans = findReplaceableNounSpans(text, prepared);
    expect(texts(text, spans)).toContain('example-project');
    expect(spans.every((span) => span.kind === 'project')).toBe(true);
  });

  it('does not derive a name shorter than 4 code points (a folder called "app" would damage ordinary words)', () => {
    const prepared = prepareKeys({ projectRoots: ['/work/hello-world/app'], properNouns: [] });
    expect(findReplaceableNounSpans('the app is an application', prepared)).toEqual([]);
    expect(findDetectableNounSpans('the app', prepared)).toEqual([]);
  });

  it.each(['test', 'docs', 'server', 'client', 'Test', 'SERVER'])(
    'does not derive a name from a generic folder called %s (it would damage "vitest@4.1.11" and "the test server")',
    (folder) => {
      const prepared = prepareKeys({ projectRoots: [`/work/${folder}`], properNouns: [] });
      const text = 'installed vitest@4.1.11; the test server and the docs client';
      expect(findReplaceableNounSpans(text, prepared)).toEqual([]);
      expect(findDetectableNounSpans(text, prepared)).toEqual([]);
    },
  );

  it('still searches the whole root path of a generic folder', () => {
    const prepared = prepareKeys({ projectRoots: ['/work/test'], properNouns: [] });
    const text = 'cwd /work/test/src';
    expect(texts(text, findProjectRootSpans(text, prepared))).toEqual(['/work/test']);
  });

  it('still derives a name from a folder that merely contains a generic word', () => {
    const prepared = prepareKeys({ projectRoots: ['/work/test-bench', '/work/my-server'], properNouns: [] });
    const text = 'a test-bench and my-server';
    expect(texts(text, findReplaceableNounSpans(text, prepared)).sort()).toEqual(['my-server', 'test-bench']);
  });
});

describe('invisible characters in keys are removed the same way as in the text', () => {
  it('matches a noun that was registered with a Default_Ignorable character inside it', () => {
    const prepared = prepareKeys({ projectRoots: [], properNouns: [noun('user', 'exam\u034Fple-user'), noun('host', 'host\u180B-name')] });
    const text = 'example-user host-name';
    expect(texts(text, findReplaceableNounSpans(text, prepared))).toEqual(['example-user', 'host-name']);
  });

  it('matches a root registered with a ZWJ emoji', () => {
    const prepared = prepareKeys({ projectRoots: ['/work/\u{1F468}\u200D\u{1F4BB}-proj'], properNouns: [] });
    expect(findProjectRootSpans('at /work/\u{1F468}\u{1F4BB}-proj/x', prepared)).toHaveLength(1);
  });
});

describe('prepared patterns carry no state between calls', () => {
  it('finds a match at the start of the text even if another piece of code left lastIndex far away', () => {
    const prepared = prepareKeys({
      projectRoots: ['/work/example-project'],
      properNouns: [noun('user', 'example-user'), noun('host', 'tom')],
    });
    const patterns = [
      ...prepared.projectRoots,
      ...prepared.replaceableNouns.map(({ pattern }) => pattern),
      ...prepared.detectableNouns.map(({ pattern }) => pattern),
    ];
    expect(patterns.length).toBeGreaterThan(3);
    for (const pattern of patterns) pattern.lastIndex = 9_999;
    const text = '/work/example-project example-user tom';
    expect(findProjectRootSpans(text, prepared)).toHaveLength(1);
    expect(findReplaceableNounSpans(text, prepared)).toHaveLength(2);
    expect(findDetectableNounSpans(text, prepared)).toHaveLength(3);
  });
});
