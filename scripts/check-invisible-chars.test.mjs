// bdboard-ekvi: scripts/check-invisible-chars.mjs のテスト。
//
// このファイル自身も検査の対象 (scripts/ 配下の .mjs) なので、検査が止める文字は生で書かない。
// `cp(0x202e)` のように String.fromCodePoint で組み立てる (エスケープ表記の `\u202E` を文字列の中に
// 「テキストとして」置くのは、生の文字ではないので検査を通る)。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  charName,
  decodeSource,
  escapeForDisplay,
  EXIT_FOUND,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  findInvisibleChars,
  isDirectRun,
  isTargetPath,
  main,
} from './check-invisible-chars.mjs';
import { RM_OPTIONS, useQuietGitProcessEnv } from './test-support/quiet-git.mjs';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-invisible-chars.mjs');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const cp = (codePoint) => String.fromCodePoint(codePoint);
const hex = (codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
// ソース上のエスケープ表記 (BMP は \uXXXX、BMP 外は \u{XXXXX})。生の文字ではなく ASCII のテキスト。
const esc = (codePoint) =>
  codePoint > 0xffff
    ? `\\u{${codePoint.toString(16).toUpperCase()}}`
    : `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, offset) => from + offset);

// bdboard-ekvi で指定した集合: bidi 制御 + ゼロ幅 / 見えない書式文字。
const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];
// bdboard-rqzv で足した集合: 見えない識別子・書式文字・行/段落区切り・タグ文字。
const SOFT_HYPHEN_AND_FILLERS = [0x00ad, 0x180e, 0x3164, 0xffa0];
const INVISIBLE_OPERATORS = range(0x2061, 0x2064);
const DEPRECATED_FORMAT = range(0x206a, 0x206f);
const LINE_PARAGRAPH_SEPARATORS = [0x2028, 0x2029];
const TAGS_BLOCK = range(0xe0000, 0xe007f);
const ADDED_BMP = [...SOFT_HYPHEN_AND_FILLERS, ...INVISIBLE_OPERATORS, ...DEPRECATED_FORMAT, ...LINE_PARAGRAPH_SEPARATORS];

describe('findInvisibleChars', () => {
  it.each([...BIDI, ...ZERO_WIDTH, ...ADDED_BMP, 0xe0000, 0xe0001, 0xe0020, 0xe007e, 0xe007f].map((codePoint) => [
    hex(codePoint),
    codePoint,
  ]))('flags a literal %s with its line, column and code point', (_label, codePoint) => {
    expect(findInvisibleChars(`const s = 'a${cp(codePoint)}b';\n`)).toEqual([
      { line: 1, column: 13, codePoint: hex(codePoint) },
    ]);
  });

  it('flags every code point of the Unicode Tags block U+E0000-U+E007F (a smuggled-ASCII channel)', () => {
    const text = TAGS_BLOCK.map((codePoint) => cp(codePoint)).join('');
    expect(findInvisibleChars(text).map((finding) => finding.codePoint)).toEqual(TAGS_BLOCK.map(hex));
  });

  it('does not flag the neighbours of the added ranges (U+2800 braille blank is visible, U+2065 / U+E0080 / U+E0100 are outside)', () => {
    for (const codePoint of [0x2800, 0x2065, 0xe0080, 0xe0100, 0xdffff, 0x00ac, 0x00ae, 0x3163, 0x3165, 0xff9f, 0xffa1]) {
      expect(findInvisibleChars(`a${cp(codePoint)}b`)).toEqual([]);
    }
  });

  it('keeps the column right when a Tags-block character (a surrogate pair) precedes a later finding', () => {
    expect(findInvisibleChars(`a${cp(0xe0041)}${cp(0x200b)}`)).toEqual([
      { line: 1, column: 2, codePoint: 'U+E0041' },
      { line: 1, column: 4, codePoint: 'U+200B' },
    ]);
  });

  it('passes the same characters written as \\u escapes (the escape is plain text, not the character)', () => {
    const escaped = [...BIDI, ...ZERO_WIDTH, ...ADDED_BMP].map(esc).join('');
    expect(findInvisibleChars(`const s = '${escaped}';\nconst r = /[${escaped}]/u;\n`)).toEqual([]);
    expect(findInvisibleChars("const s = '\\u{202E}\\u{E0041}';\n")).toEqual([]);
    expect(findInvisibleChars(`const s = '${TAGS_BLOCK.map(esc).join('')}';\n`)).toEqual([]);
  });

  it('reports 1-based line and column, in the order they appear', () => {
    const text = `ab\ncd${cp(0x202e)}e${cp(0x200b)}\n\nz${cp(0xfeff)}`;
    expect(findInvisibleChars(text)).toEqual([
      { line: 2, column: 3, codePoint: 'U+202E' },
      { line: 2, column: 5, codePoint: 'U+200B' },
      { line: 4, column: 2, codePoint: 'U+FEFF' },
    ]);
  });

  it('counts lines the same way for CRLF and bare CR', () => {
    expect(findInvisibleChars(`a\r\nb${cp(0x202e)}`)).toEqual([{ line: 2, column: 2, codePoint: 'U+202E' }]);
    expect(findInvisibleChars(`a\rb${cp(0x202e)}`)).toEqual([{ line: 2, column: 2, codePoint: 'U+202E' }]);
  });

  it('flags a leading BOM as well (no tracked file needs one)', () => {
    expect(findInvisibleChars(`${cp(0xfeff)}export {};\n`)).toEqual([{ line: 1, column: 1, codePoint: 'U+FEFF' }]);
  });

  it('counts an astral character (a surrogate pair) as two UTF-16 units before a later finding', () => {
    // U+1F469 は UTF-16 で 2 コード単位。列は JS の文字列の位置 (index + 1) で数える。
    expect(findInvisibleChars(`a${cp(0x1f469)}${cp(0x202e)}`)).toEqual([{ line: 1, column: 4, codePoint: 'U+202E' }]);
    expect(findInvisibleChars(`${cp(0x1f469)}\n${cp(0x1f469)}${cp(0x200b)}`)).toEqual([
      { line: 2, column: 3, codePoint: 'U+200B' },
    ]);
  });

  it('flags every occurrence, including several on one line', () => {
    expect(findInvisibleChars(`${cp(0x200b)}${cp(0x200b)}`)).toEqual([
      { line: 1, column: 1, codePoint: 'U+200B' },
      { line: 1, column: 2, codePoint: 'U+200B' },
    ]);
  });

  it('does not flag ordinary non-ASCII text, emoji, variation selectors or NBSP', () => {
    expect(findInvisibleChars('日本語のコメント 👩 \u00A0 \uFE0F ★ é\n')).toEqual([]);
  });
});

describe('isTargetPath', () => {
  it.each([
    'src/a.ts',
    'src/deep/dir/a.tsx',
    'web/src/a.ts',
    'web/src/components/A.tsx',
    'scripts/a.mjs',
    'scripts/test-support/quiet-git.d.mts',
    'scripts/a.cjs',
    'src/a.js',
    // bdboard-rqzv: 配布される入口・e2e・設定ファイル・.jsx / .cts
    'bin/bdboard.mjs',
    'test/e2e/smoke.spec.ts',
    'test/e2e/fixtures/bulk-selection.ts',
    'test/e2e/playwright.config.ts',
    'vitest.config.ts',
    'eslint.config.mjs',
    '.dependency-cruiser.cjs',
    'web/vite.config.ts',
    'web/vitest.config.ts',
    'web/vitest.setup.ts',
    'src/a.jsx',
    'src/a.cts',
    'web/src/components/A.jsx',
  ])('targets %s', (relPath) => {
    expect(isTargetPath(relPath)).toBe(true);
  });

  it.each([
    'docs/a.ts',
    'test/fixtures/a.ts',
    'test/a.ts',
    'test/e2e/README.md',
    'test/e2e/fixtures/bin/bd',
    'test/e2e/tsconfig.json',
    'harness/a.mjs',
    'srcx/a.ts',
    'binx/a.mjs',
    'bin/a.md',
    'src/a.md',
    'src/a.json',
    'src/a.css',
    'web/a.ts',
    'web/index.ts',
    'web/tsconfig.json',
    'web/vite.config.js',
    'sub/vitest.config.ts',
    'a.ts',
    'a.cts',
    'tsconfig.json',
  ])('does not target %s', (relPath) => {
    expect(isTargetPath(relPath)).toBe(false);
  });
});

describe('charName', () => {
  it('names every flagged code point with a plain ASCII label', () => {
    for (const codePoint of [...BIDI, ...ZERO_WIDTH, ...ADDED_BMP, ...TAGS_BLOCK]) {
      expect(charName(codePoint)).toMatch(/^[A-Z0-9][A-Z0-9 ()-]*$/);
    }
    expect(charName(0x00ad)).toBe('SOFT HYPHEN');
    expect(charName(0x180e)).toBe('MONGOLIAN VOWEL SEPARATOR');
    expect(charName(0x3164)).toBe('HANGUL FILLER');
    expect(charName(0xffa0)).toBe('HALFWIDTH HANGUL FILLER');
    expect(charName(0x2028)).toBe('LINE SEPARATOR');
    expect(charName(0x2029)).toBe('PARAGRAPH SEPARATOR');
    expect(charName(0xe0041)).toBe('TAG CHARACTER');
  });

  it('returns undefined for a code point that is not flagged', () => {
    expect(charName(0x61)).toBeUndefined();
    expect(charName(0x2800)).toBeUndefined();
    expect(charName(0xe0080)).toBeUndefined();
  });
});

describe('escapeForDisplay', () => {
  it('leaves printable ASCII, spaces and ordinary non-ASCII text (Japanese, emoji) as they are', () => {
    expect(escapeForDisplay('src/a b/c.ts')).toBe('src/a b/c.ts');
    expect(escapeForDisplay('src/日本語/テスト.ts')).toBe('src/日本語/テスト.ts');
    expect(escapeForDisplay(`src/${cp(0x1f469)}.ts`)).toBe(`src/${cp(0x1f469)}.ts`);
  });

  it('writes bidi, zero-width, filler and tag characters as \\u escapes (a file name must not reorder the line it is printed in)', () => {
    for (const codePoint of [...BIDI, ...ZERO_WIDTH, ...ADDED_BMP, 0xe0000, 0xe0041, 0xe007f]) {
      const shown = escapeForDisplay(`src/a${cp(codePoint)}b.ts`);
      expect(shown).toBe(`src/a${esc(codePoint)}b.ts`);
      expect(shown).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it('escapes control characters (a newline would forge a diagnostic line, ESC would drive the terminal)', () => {
    expect(escapeForDisplay('a\nb\rc\x1b[31m\x7f\x85\t')).toBe('a\\u000Ab\\u000Dc\\u001B[31m\\u007F\\u0085\\u0009');
  });

  it('escapes non-ASCII spaces and a lone surrogate, but not the plain space', () => {
    expect(escapeForDisplay(`a${cp(0xa0)}b${cp(0x3000)}c d`)).toBe('a\\u00A0b\\u3000c d');
    expect(escapeForDisplay('a\ud800b')).toBe('a\\uD800b');
  });

  it('escapes a backslash so that a literal "\\u202E" in a name cannot be mistaken for an escaped character', () => {
    expect(escapeForDisplay('src/a\\u202Eb.ts')).toBe('src/a\\u005Cu202Eb.ts');
    expect(escapeForDisplay(`src/a${cp(0x202e)}b.ts`)).not.toBe(escapeForDisplay('src/a\\u202Eb.ts'));
  });
});

describe('decodeSource', () => {
  const utf16le = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const utf16be = (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);

  it('decodes plain UTF-8 as it is, keeping a leading UTF-8 BOM as U+FEFF', () => {
    expect(decodeSource(Buffer.from('export const a = 1;\n', 'utf8'))).toBe('export const a = 1;\n');
    expect(decodeSource(Buffer.from(`${cp(0xfeff)}x`, 'utf8'))).toBe(`${cp(0xfeff)}x`);
  });

  it('decodes UTF-16LE and UTF-16BE (by their BOM) so a file saved in UTF-16 is inspected like any other', () => {
    expect(decodeSource(utf16le('const s = 1;\n'))).toBe(`${cp(0xfeff)}const s = 1;\n`);
    expect(decodeSource(utf16be('const s = 1;\n'))).toBe(`${cp(0xfeff)}const s = 1;\n`);
    expect(decodeSource(utf16le(`a${cp(0x202e)}${cp(0x1f469)}`))).toBe(`${cp(0xfeff)}a${cp(0x202e)}${cp(0x1f469)}`);
  });

  it('ignores a dangling odd byte of a UTF-16 file instead of throwing', () => {
    expect(decodeSource(Buffer.concat([utf16le('ab'), Buffer.from([0x41])]))).toBe(`${cp(0xfeff)}ab`);
    expect(decodeSource(Buffer.concat([utf16be('ab'), Buffer.from([0x41])]))).toBe(`${cp(0xfeff)}ab`);
  });

  it('copes with empty and one-byte input', () => {
    expect(decodeSource(Buffer.alloc(0))).toBe('');
    expect(decodeSource(Buffer.from([0xff]))).toBe(Buffer.from([0xff]).toString('utf8'));
  });
});

describe('isDirectRun', () => {
  let tmpRoot;
  const symlinkSupported = process.platform !== 'win32';

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'invisible-chars-direct-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, RM_OPTIONS);
  });

  it('is true when argv[1] is the module file itself', () => {
    expect(isDirectRun(pathToFileURL(SCRIPT_PATH).href, SCRIPT_PATH)).toBe(true);
  });

  it('is false when argv[1] is another file (the module is imported by something else)', () => {
    expect(isDirectRun(pathToFileURL(SCRIPT_PATH).href, path.join(path.dirname(SCRIPT_PATH), 'check-invisible-chars.test.mjs'))).toBe(false);
  });

  it('is false when there is no argv[1] or it does not exist', () => {
    expect(isDirectRun(pathToFileURL(SCRIPT_PATH).href, undefined)).toBe(false);
    expect(isDirectRun(pathToFileURL(SCRIPT_PATH).href, path.join(tmpRoot, 'missing.mjs'))).toBe(false);
  });

  it.skipIf(!symlinkSupported)('is true when argv[1] reaches the module through a symlinked file (node reports the real URL)', () => {
    const link = path.join(tmpRoot, 'link.mjs');
    fs.symlinkSync(SCRIPT_PATH, link);
    expect(isDirectRun(pathToFileURL(SCRIPT_PATH).href, link)).toBe(true);
  });

  it('is true when argv[1] reaches the module through a symlinked directory (macOS /tmp -> /private/tmp)', () => {
    const linkedDir = path.join(tmpRoot, 'linked-scripts');
    fs.symlinkSync(path.dirname(SCRIPT_PATH), linkedDir, 'junction');
    expect(isDirectRun(pathToFileURL(SCRIPT_PATH).href, path.join(linkedDir, path.basename(SCRIPT_PATH)))).toBe(true);
  });
});

describe('check-invisible-chars CLI', () => {
  useQuietGitProcessEnv();
  let tmpRoot;
  let work;

  function git(...args) {
    execFileSync('git', args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  function write(relPath, text) {
    fs.mkdirSync(path.dirname(path.join(work, relPath)), { recursive: true });
    fs.writeFileSync(path.join(work, relPath), text);
  }

  function run() {
    return spawnSync(process.execPath, [SCRIPT_PATH, `--repo=${work}`], { encoding: 'utf8' });
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'invisible-chars-'));
    work = path.join(tmpRoot, 'work');
    fs.mkdirSync(work);
    git('init', '-q', '-b', 'main');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, RM_OPTIONS);
  });

  it('exits 0 for files that only use escapes', () => {
    write('src/ok.ts', "export const s = '\\u202E\\u200B';\n");
    git('add', 'src/ok.ts');
    const result = run();
    expect(result.status).toBe(EXIT_OK);
  });

  it('fails on a literal U+202E and names the file, line, column and code point without printing the character', () => {
    const rlo = cp(0x202e);
    write('src/ok.ts', 'export const ok = 1;\n');
    write('src/bad.ts', `export const a = 1;\nexport const s = '${rlo}';\n`);
    git('add', 'src/ok.ts', 'src/bad.ts');
    const result = run();
    expect(result.status).toBe(EXIT_FOUND);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('src/bad.ts:2:19');
    expect(output).toContain('U+202E');
    expect(output).not.toContain('src/ok.ts');
    expect(output).not.toContain(rlo);
    // 診断の 1 行は ASCII だけ (生の文字を混ぜない) で、JSX ではエスケープが解釈されない旨の案内を含む。
    const findingLine = result.stderr.split('\n').find((line) => line.includes('src/bad.ts:2:19'));
    expect(findingLine).toMatch(/^[\x20-\x7E]+$/);
    expect(findingLine).toContain('JSX');
  });

  it('reports a file in a merge conflict once (git ls-files lists an unmerged path once per stage)', () => {
    const author = ['-c', 'user.name=example-user', '-c', 'user.email=example@example.com'];
    write('src/c.ts', 'export const a = 1;\n');
    git('add', 'src/c.ts');
    git(...author, 'commit', '-q', '-m', 'base');
    git('switch', '-q', '-c', 'side');
    write('src/c.ts', `export const a = 2; // ${cp(0x202e)}\n`);
    git(...author, 'commit', '-q', '-am', 'side');
    git('switch', '-q', 'main');
    write('src/c.ts', 'export const a = 3;\n');
    git(...author, 'commit', '-q', '-am', 'main');
    // 競合して exit 1 になるのが正常 (execFileSync ではなく spawnSync で、失敗しても投げない)。
    spawnSync('git', [...author, 'merge', '-q', 'side'], { cwd: work });
    const result = run();
    expect(result.status).toBe(EXIT_FOUND);
    expect(result.stderr).toContain('1 件を 1 ファイル');
  });

  it('also catches a new file that is not yet added to git', () => {
    write('src/new.ts', `export const s = '${cp(0x200b)}';\n`);
    const result = run();
    expect(result.status).toBe(EXIT_FOUND);
    expect(`${result.stdout}${result.stderr}`).toContain('src/new.ts:1:19');
  });

  it('lists every finding (file, line, column, code point), not just the first', () => {
    write('src/a.ts', `${cp(0x200e)}x\n`);
    write('scripts/b.mjs', `x${cp(0x2069)}\n`);
    const result = run();
    expect(result.status).toBe(EXIT_FOUND);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('src/a.ts:1:1');
    expect(output).toContain('U+200E');
    expect(output).toContain('scripts/b.mjs:1:2');
    expect(output).toContain('U+2069');
  });

  it('ignores files outside the target scope and non-source extensions', () => {
    write('docs/note.ts', `${cp(0x202e)}\n`);
    write('src/note.md', `${cp(0x202e)}\n`);
    write('test/fixtures/a.ts', `${cp(0x202e)}\n`);
    write('test/e2e/README.md', `${cp(0x202e)}\n`);
    write('web/index.ts', `${cp(0x202e)}\n`);
    write('bin/note.md', `${cp(0x202e)}\n`);
    expect(run().status).toBe(EXIT_OK);
  });

  // bdboard-rqzv (N6): 配布される入口・e2e・設定ファイル・.jsx / .cts も検査する。
  it.each([
    'bin/bdboard.mjs',
    'test/e2e/smoke.spec.ts',
    'test/e2e/fixtures/helpers.ts',
    'vitest.config.ts',
    'eslint.config.mjs',
    '.dependency-cruiser.cjs',
    'web/vite.config.ts',
    'web/vitest.config.ts',
    'web/vitest.setup.ts',
    'src/Widget.jsx',
    'src/legacy.cts',
  ])('catches a literal character in %s', (relPath) => {
    write(relPath, `${cp(0x202e)}x\n`);
    const result = run();
    expect(result.status).toBe(EXIT_FOUND);
    expect(result.stderr).toContain(`${relPath}:1:1 U+202E`);
  });

  it.each([
    [0x00ad, 'SOFT HYPHEN'],
    [0x180e, 'MONGOLIAN VOWEL SEPARATOR'],
    [0x3164, 'HANGUL FILLER'],
    [0xffa0, 'HALFWIDTH HANGUL FILLER'],
    [0x2063, 'INVISIBLE SEPARATOR'],
    [0x206f, 'NOMINAL DIGIT SHAPES'],
    [0x2028, 'LINE SEPARATOR'],
    [0xe0041, 'TAG CHARACTER'],
  ].map(([codePoint, name]) => [hex(codePoint), codePoint, name]))('names the added code point %s in the diagnostic without printing it', (_label, codePoint, name) => {
    write('src/a.ts', `export const s = '${cp(codePoint)}';\n`);
    const result = run();
    expect(result.status).toBe(EXIT_FOUND);
    expect(result.stderr).toContain(`${hex(codePoint)} ${name}`);
    expect(result.stderr).not.toContain(cp(codePoint));
  });

  // bdboard-rqzv (N2): ファイル名の中の制御文字は診断にそのまま出さない。
  it('prints a file name that contains a bidi character as a \\u escape, never as the character', () => {
    const rlo = cp(0x202e);
    write(`src/a${rlo}b.ts`, `export const s = '${cp(0x200b)}';\n`);
    const result = run();
    expect(result.status).toBe(EXIT_FOUND);
    expect(result.stderr).toContain('src/a\\u202Eb.ts:1:19 U+200B');
    expect(result.stderr).not.toContain(rlo);
    const findingLine = result.stderr.split('\n').find((line) => line.includes('src/a\\u202Eb.ts:1:19'));
    expect(findingLine).toMatch(/^[\x20-\x7E]+$/);
  });

  it('prints the name of an unreadable file as escapes too (exit 2)', () => {
    const rlo = cp(0x202e);
    write(`src/odd${rlo}.ts`, 'export const odd = 1;\n');
    git('add', '-A');
    fs.rmSync(path.join(work, `src/odd${rlo}.ts`));
    fs.mkdirSync(path.join(work, `src/odd${rlo}.ts`));
    const result = run();
    expect(result.status).toBe(EXIT_UNAVAILABLE);
    expect(result.stderr).toContain('src/odd\\u202E.ts');
    expect(result.stderr).not.toContain(rlo);
  });

  // bdboard-rqzv (N5): symlink を含むパスから起動しても「直接起動か」の判定が外れない。
  it('still checks when the script is started through a symlinked directory (it used to exit 0 without checking)', () => {
    write('src/bad.ts', `export const s = '${cp(0x202e)}';\n`);
    const linkedDir = path.join(tmpRoot, 'linked-scripts');
    fs.symlinkSync(path.dirname(SCRIPT_PATH), linkedDir, 'junction');
    const result = spawnSync(process.execPath, [path.join(linkedDir, 'check-invisible-chars.mjs'), `--repo=${work}`], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(EXIT_FOUND);
    expect(result.stderr).toContain('src/bad.ts:1:19 U+202E');
  });

  it.skipIf(process.platform === 'win32')('still checks when the script path itself is a symlink', () => {
    write('src/bad.ts', `export const s = '${cp(0x202e)}';\n`);
    const link = path.join(tmpRoot, 'link-to-script.mjs');
    fs.symlinkSync(SCRIPT_PATH, link);
    const result = spawnSync(process.execPath, [link, `--repo=${work}`], { encoding: 'utf8' });
    expect(result.status).toBe(EXIT_FOUND);
    expect(result.stderr).toContain('src/bad.ts:1:19 U+202E');
  });

  // bdboard-rqzv (N7): UTF-16 で保存されたファイルも、デコードして同じ規則で検査する。
  it.each([
    ['UTF-16LE', (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])],
    ['UTF-16BE', (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])],
  ])('inspects a file saved as %s (BOM) instead of passing it unread', (_label, encode) => {
    write('src/utf16.ts', encode(`export const s = '${cp(0x202e)}';\n`));
    const result = run();
    expect(result.status).toBe(EXIT_FOUND);
    // BOM (U+FEFF) 自体と、本文の U+202E (BOM の分だけ列が 1 ずれる) の両方が出る。
    expect(result.stderr).toContain('src/utf16.ts:1:1 U+FEFF');
    expect(result.stderr).toContain('src/utf16.ts:1:20 U+202E');
  });

  // bdboard-rqzv (N7): repo の外を指す symlink は辿らない。repo 内を指す symlink は今までどおり辿る。
  it.skipIf(process.platform === 'win32')('does not follow a symlink that leaves the repository (warns and skips it)', () => {
    const outside = path.join(tmpRoot, 'outside.ts');
    fs.writeFileSync(outside, `export const s = '${cp(0x202e)}';\n`);
    fs.mkdirSync(path.join(work, 'src'), { recursive: true });
    fs.symlinkSync(outside, path.join(work, 'src/leak.ts'));
    write('src/ok.ts', 'export const ok = 1;\n');
    git('add', 'src/leak.ts', 'src/ok.ts');
    const result = run();
    expect(result.status).toBe(EXIT_OK);
    expect(result.stderr).toContain('src/leak.ts');
    expect(result.stderr).toContain('symlink');
    expect(result.stdout).toContain('(1 ファイルを検査)');
  });

  it.skipIf(process.platform === 'win32')('still follows a symlink that stays inside the repository', () => {
    write('docs/shared.ts', `export const s = '${cp(0x202e)}';\n`);
    fs.mkdirSync(path.join(work, 'src'), { recursive: true });
    fs.symlinkSync('../docs/shared.ts', path.join(work, 'src/alias.ts'));
    git('add', 'docs/shared.ts', 'src/alias.ts');
    const result = run();
    expect(result.status).toBe(EXIT_FOUND);
    expect(result.stderr).toContain('src/alias.ts:1:19 U+202E');
  });

  it.skipIf(process.platform === 'win32')('treats a dangling symlink like a deleted file (skipped, not a failure)', () => {
    fs.mkdirSync(path.join(work, 'src'), { recursive: true });
    fs.symlinkSync('missing-target.ts', path.join(work, 'src/dangling.ts'));
    write('src/ok.ts', 'export const ok = 1;\n');
    git('add', 'src/dangling.ts', 'src/ok.ts');
    const result = run();
    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toContain('(1 ファイルを検査)');
  });

  it('ignores git-ignored files', () => {
    write('.gitignore', 'src/ignored.ts\n');
    write('src/ignored.ts', `${cp(0x202e)}\n`);
    expect(run().status).toBe(EXIT_OK);
  });

  it('skips a tracked file that was deleted from the work tree (git ls-files --cached still lists it)', () => {
    write('src/gone.ts', 'export const gone = 1;\n');
    write('src/ok.ts', 'export const ok = 1;\n');
    git('add', 'src/gone.ts', 'src/ok.ts');
    fs.rmSync(path.join(work, 'src/gone.ts'));
    const result = run();
    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toContain('(1 ファイルを検査)');
  });

  it('exits 2 (not a pass) when a listed file exists but cannot be read', () => {
    // 追跡中のパスをディレクトリに置き換える (EISDIR)。chmod と違い Windows でも同じに再現できる。
    write('src/odd.ts', 'export const odd = 1;\n');
    git('add', 'src/odd.ts');
    fs.rmSync(path.join(work, 'src/odd.ts'));
    fs.mkdirSync(path.join(work, 'src/odd.ts'));
    const result = run();
    expect(result.status).toBe(EXIT_UNAVAILABLE);
    expect(result.stderr).toContain('src/odd.ts');
  });

  it('exits 2 (not a pass) when it cannot list files', () => {
    const notARepo = path.join(tmpRoot, 'not-a-repo');
    fs.mkdirSync(notARepo);
    const result = spawnSync(process.execPath, [SCRIPT_PATH, `--repo=${notARepo}`], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpRoot },
    });
    expect(result.status).toBe(EXIT_UNAVAILABLE);
  });
});

describe('this repository', () => {
  it('has no literal invisible characters in the target source files (the 4 files fixed by bdboard-ekvi included)', () => {
    expect(main([`--repo=${REPO_ROOT}`])).toBe(EXIT_OK);
  });

  it('wires check:invisible-chars into verify:steps and verify:light', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:invisible-chars']).toBe('node scripts/check-invisible-chars.mjs');
    expect(pkg.scripts['verify:steps']).toContain('npm run check:invisible-chars');
    expect(pkg.scripts['verify:light']).toContain('npm run check:invisible-chars');
  });
});
