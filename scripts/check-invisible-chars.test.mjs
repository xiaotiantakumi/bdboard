// bdboard-ekvi: scripts/check-invisible-chars.mjs のテスト。
//
// このファイル自身も検査の対象 (scripts/ 配下の .mjs) なので、検査が止める文字は生で書かない。
// `cp(0x202e)` のように String.fromCodePoint で組み立てる (エスケープ表記の `\u202E` を文字列の中に
// 「テキストとして」置くのは、生の文字ではないので検査を通る)。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXIT_FOUND,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  findInvisibleChars,
  isTargetPath,
  main,
} from './check-invisible-chars.mjs';
import { RM_OPTIONS, useQuietGitProcessEnv } from './test-support/quiet-git.mjs';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-invisible-chars.mjs');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const cp = (codePoint) => String.fromCodePoint(codePoint);
const hex = (codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

// チケットが指定した集合: bidi 制御 + ゼロ幅 / 見えない書式文字。
const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];

describe('findInvisibleChars', () => {
  it.each([...BIDI, ...ZERO_WIDTH].map((codePoint) => [hex(codePoint), codePoint]))(
    'flags a literal %s with its line, column and code point',
    (_label, codePoint) => {
      expect(findInvisibleChars(`const s = 'a${cp(codePoint)}b';\n`)).toEqual([
        { line: 1, column: 13, codePoint: hex(codePoint) },
      ]);
    },
  );

  it('passes the same characters written as \\u escapes (the escape is plain text, not the character)', () => {
    const escaped = [...BIDI, ...ZERO_WIDTH]
      .map((codePoint) => `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`)
      .join('');
    expect(findInvisibleChars(`const s = '${escaped}';\nconst r = /[${escaped}]/u;\n`)).toEqual([]);
    expect(findInvisibleChars("const s = '\\u{202E}';\n")).toEqual([]);
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
  ])('targets %s', (relPath) => {
    expect(isTargetPath(relPath)).toBe(true);
  });

  it.each([
    'docs/a.ts',
    'test/e2e/a.ts',
    'harness/a.mjs',
    'srcx/a.ts',
    'src/a.md',
    'src/a.json',
    'src/a.css',
    'web/a.ts',
    'a.ts',
  ])('does not target %s', (relPath) => {
    expect(isTargetPath(relPath)).toBe(false);
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

  it('ignores files outside src / web/src / scripts and non-source extensions', () => {
    write('docs/note.ts', `${cp(0x202e)}\n`);
    write('src/note.md', `${cp(0x202e)}\n`);
    write('test/e2e/a.ts', `${cp(0x202e)}\n`);
    expect(run().status).toBe(EXIT_OK);
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
