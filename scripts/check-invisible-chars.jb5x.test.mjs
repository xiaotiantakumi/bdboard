// bdboard-jb5x: check:invisible-chars の異体字セレクタ・新しい範囲 (.sh / 拡張子の無い stub / yml)・診断文のテスト。
// 追加文字 (U+034F ほか) と isTargetPath の表、「this repository」の自己検査は scripts/check-invisible-chars.test.mjs にある。
//
// このファイル自身も検査の対象 (scripts/ 配下の .mjs) なので、検査が止める文字は生で書かない。入力は String.fromCodePoint で
// 組み立て、エスケープ表記 (ASCII のテキスト) は esc() で作る。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adviceKind,
  charName,
  EXIT_FOUND,
  EXIT_OK,
  escapeForDisplay,
  findInvisibleChars,
} from './check-invisible-chars.mjs';
import { fixAdvice } from './check-invisible-chars/advice.mjs';
import { isEmojiVariationSelector, isVariationSelector } from './check-invisible-chars/chars.mjs';
import { RM_OPTIONS, useQuietGitProcessEnv } from './test-support/quiet-git.mjs';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-invisible-chars.mjs');

const cp = (codePoint) => String.fromCodePoint(codePoint);
const chars = (...codePoints) => String.fromCodePoint(...codePoints);
const hex = (codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
const esc = (codePoint) => `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
const finding = (line, column, codePoint) => ({ line, column, codePoint: hex(codePoint) });

const WARNING = 0x26a0;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;

describe('findInvisibleChars: variation selectors (bdboard-jb5x)', () => {
  it.each([
    ['WARNING SIGN + VS16 then a space (scripts/bd-prime-guard.mjs)', chars(WARNING, VS16, 0x20)],
    ['HEAVY BLACK HEART + VS16', chars(0x2764, VS16)],
    ['COPYRIGHT SIGN + VS16', chars(0xa9, VS16)],
    ['WARNING SIGN + VS15 (text style)', chars(WARNING, VS15)],
    ['an astral emoji (EYE) + VS16', chars(0x1f441, VS16)],
    ['keycap 1', chars(0x31, VS16, KEYCAP)],
    ['keycap #', chars(0x23, VS16, KEYCAP)],
    ['keycap *', chars(0x2a, VS16, KEYCAP)],
  ])('passes %s', (_label, text) => {
    expect(findInvisibleChars(`const s = '${text}';\n`)).toEqual([]);
  });

  it('flags only the ZWJ in a ZWJ sequence of emoji presentation selectors (the selectors themselves pass)', () => {
    // U+1F441 は UTF-16 で 2 単位: 列は 1-2 が EYE、3 が VS16、4 が ZWJ。
    expect(findInvisibleChars(chars(0x1f441, VS16, 0x200d, 0x1f5e8, VS16))).toEqual([finding(1, 4, 0x200d)]);
  });

  it.each([
    ['VS16 after an ASCII letter', `a${cp(VS16)}`, [finding(1, 2, VS16)]],
    ['VS15 after an ASCII letter', `a${cp(VS15)}`, [finding(1, 2, VS15)]],
    ['VS16 right after a quote', `'${cp(VS16)}'`, [finding(1, 2, VS16)]],
    ['VS16 at the start of the text', cp(VS16), [finding(1, 1, VS16)]],
    ['VS16 at the start of a line (after LF)', `a\n${cp(VS16)}`, [finding(2, 1, VS16)]],
    ['VS16 at the start of a line (after CRLF)', `a\r\n${cp(VS16)}`, [finding(2, 1, VS16)]],
    ['VS16 after a keycap base without U+20E3', chars(0x31, VS16), [finding(1, 2, VS16)]],
    ['VS16 + U+20E3 after something that is not a keycap base', chars(0x61, VS16, KEYCAP), [finding(1, 2, VS16)]],
    ['VS15 + U+20E3 (the keycap exception is VS16 only)', chars(0x31, VS15, KEYCAP), [finding(1, 2, VS15)]],
    ['a second VS16 right after an emoji presentation selector', chars(WARNING, VS16, VS16), [finding(1, 3, VS16)]],
    ['a VS16 after a Han character', chars(0x8fbb, VS16), [finding(1, 2, VS16)]],
  ])('flags %s', (_label, text, expected) => {
    expect(findInvisibleChars(text)).toEqual(expected);
  });

  it('flags VS1-VS14 (U+FE00-U+FE0D) even right after an emoji', () => {
    const selectors = range(0xfe00, 0xfe0d);
    for (const selector of selectors) {
      expect(findInvisibleChars(chars(WARNING, selector))).toEqual([finding(1, 2, selector)]);
    }
  });

  it('flags every VS17-VS256 (U+E0100-U+E01EF) after an emoji, a Han character and an ASCII letter', () => {
    const selectors = range(0xe0100, 0xe01ef);
    expect(selectors).toHaveLength(240);
    for (const base of [WARNING, 0x8fbb, 0x61]) {
      const text = `${cp(base)}${selectors.map(cp).join('')}`;
      const found = findInvisibleChars(text);
      expect(found.map((one) => one.codePoint)).toEqual(selectors.map(hex));
      // 基底が BMP の 1 単位、続く異体字セレクタは BMP 外の 2 単位ずつ。
      expect(found[0]).toEqual(finding(1, 2, 0xe0100));
      expect(found[1]).toEqual(finding(1, 4, 0xe0101));
    }
  });

  it('flags every selector of a GlassWorm-style payload hidden between quotes, with the right columns', () => {
    const payload = range(0xe0100, 0xe0107);
    const text = `const s = '${payload.map(cp).join('')}';\n`;
    expect(findInvisibleChars(text)).toEqual(payload.map((codePoint, index) => finding(1, 12 + 2 * index, codePoint)));
  });

  it('flags all 16 selectors U+FE00-U+FE0F chained after an ASCII letter', () => {
    const chain = range(0xfe00, 0xfe0f);
    expect(findInvisibleChars(`a${chain.map(cp).join('')}`)).toEqual(chain.map((codePoint, index) => finding(1, 2 + index, codePoint)));
  });

  it('keeps the column right after an astral emoji plus its selector', () => {
    expect(findInvisibleChars(`${chars(0x1f441, VS16)}${cp(0x200b)}`)).toEqual([finding(1, 4, 0x200b)]);
  });

  it('passes the same selectors written as escapes (plain ASCII text)', () => {
    const escaped = range(0xfe00, 0xfe0f).map(esc).join('');
    expect(findInvisibleChars(`const s = '${escaped}\\u{E0100}';\n`)).toEqual([]);
  });
});

describe('isEmojiVariationSelector / isVariationSelector / charName (bdboard-jb5x)', () => {
  it.each([
    [VS16, WARNING, undefined, true],
    [VS15, WARNING, undefined, true],
    [VS16, 0x1f441, undefined, true],
    [VS16, undefined, undefined, false],
    [VS15, undefined, undefined, false],
    [VS16, 0x61, undefined, false],
    [VS16, 0x27, 0x27, false],
    [VS16, 0x0a, undefined, false],
    [VS16, VS16, undefined, false],
    [VS16, 0x31, KEYCAP, true],
    [VS16, 0x39, KEYCAP, true],
    [VS16, 0x23, KEYCAP, true],
    [VS16, 0x2a, KEYCAP, true],
    [VS16, 0x31, undefined, false],
    [VS16, 0x31, 0x61, false],
    [VS16, 0x61, KEYCAP, false],
    [VS15, 0x31, KEYCAP, false],
    [0xfe00, WARNING, undefined, false],
    [0xfe0d, WARNING, undefined, false],
    [0xe0100, WARNING, undefined, false],
    [0xe01ef, 0x61, undefined, false],
    [0x61, WARNING, undefined, false],
    [0x200b, WARNING, undefined, false],
  ])('isEmojiVariationSelector(%i, previous=%s, next=%s) is %s', (codePoint, previous, next, expected) => {
    expect(isEmojiVariationSelector(codePoint, previous, next)).toBe(expected);
  });

  it.each([
    [0xfdff, false],
    [0xfe00, true],
    [0xfe0f, true],
    [0xfe10, false],
    [0xe00ff, false],
    [0xe0100, true],
    [0xe01ef, true],
    [0xe01f0, false],
    [0x180b, false],
  ])('isVariationSelector(%i) is %s', (codePoint, expected) => {
    expect(isVariationSelector(codePoint)).toBe(expected);
  });

  it('names every selector VARIATION SELECTOR-<n> (1-16 for U+FE00-U+FE0F, 17-256 for U+E0100-U+E01EF)', () => {
    for (const codePoint of range(0xfe00, 0xfe0f)) expect(charName(codePoint)).toBe(`VARIATION SELECTOR-${codePoint - 0xfe00 + 1}`);
    for (const codePoint of range(0xe0100, 0xe01ef)) expect(charName(codePoint)).toBe(`VARIATION SELECTOR-${codePoint - 0xe0100 + 17}`);
    expect(charName(0xfe0f)).toBe('VARIATION SELECTOR-16');
  });

  it('escapes every selector in a file name, the ones that pass in a source file included', () => {
    expect(escapeForDisplay(`a${cp(VS16)}b${cp(0xe0100)}.ts`)).toBe(`a${esc(VS16)}b\\u{E0100}.ts`);
  });
});

describe('adviceKind (bdboard-jb5x)', () => {
  it.each([
    ['scripts/always-on-server.sh', 'shell'],
    ['.claude/skills/bdboard-harness/hooks/stop-ticket-gate.sh', 'shell'],
    ['test/e2e/fixtures/bin/bd', 'shell'],
    ['test/e2e/fixtures/bin/claude', 'shell'],
    ['.github/workflows/ci.yml', 'yaml'],
    ['.github/dependabot.yaml', 'yaml'],
    ['src/a.ts', 'js'],
    ['web/src/components/A.tsx', 'js'],
    ['scripts/a.mjs', 'js'],
    ['src\\a.jsx', 'js'],
  ])('%s is %s', (relPath, expected) => {
    expect(adviceKind(relPath)).toBe(expected);
  });
});

describe('fixAdvice (bdboard-jb5x)', () => {
  const ENCODINGS = ['utf8', 'utf16le', 'utf16be'];
  const KINDS = ['js', 'shell', 'yaml'];

  it('stays ASCII for every encoding, kind and code point (a raw character must never reach the output)', () => {
    for (const encoding of ENCODINGS) {
      for (const kind of KINDS) {
        for (const codePoint of [0x200b, VS16, 0xe0100]) {
          expect(fixAdvice({ encoding, kind, codePoint })).toMatch(/^[\x20-\x7E]+$/);
        }
      }
    }
  });

  it.each(['utf16le', 'utf16be'])('tells a %s file to be saved again as UTF-8, with no escape or JSX advice', (encoding) => {
    for (const kind of KINDS) {
      const advice = fixAdvice({ encoding, kind, codePoint: 0x202e });
      expect(advice).toContain('save it again as UTF-8 without a BOM');
      expect(advice).not.toContain('escape');
      expect(advice).not.toContain('JSX');
    }
  });

  it('gives the escape advice for a UTF-8 file, worded for the kind of file', () => {
    const js = fixAdvice({ encoding: 'utf8', kind: 'js', codePoint: 0x202e });
    expect(js).toContain('escape');
    expect(js).toContain('JSX');
    expect(js).not.toContain('UTF-16');
    const shell = fixAdvice({ encoding: 'utf8', kind: 'shell', codePoint: 0x202e });
    expect(shell).toContain("$'");
    expect(shell).not.toContain('JSX');
    const yaml = fixAdvice({ encoding: 'utf8', kind: 'yaml', codePoint: 0x202e });
    expect(yaml).toContain('double-quoted');
    expect(yaml).not.toContain('JSX');
  });

  it('adds the emoji-only rule to the advice for a variation selector, and only for one', () => {
    for (const codePoint of [0xfe00, VS15, VS16, 0xe0100, 0xe01ef]) {
      expect(fixAdvice({ encoding: 'utf8', kind: 'js', codePoint })).toContain('right after an emoji');
    }
    for (const codePoint of [0x200b, 0x180b, 0x034f]) {
      expect(fixAdvice({ encoding: 'utf8', kind: 'js', codePoint })).not.toContain('emoji');
    }
  });
});

describe('check-invisible-chars CLI: new scope, variation selectors and diagnostics (bdboard-jb5x)', () => {
  useQuietGitProcessEnv();
  let tmpRoot;
  let work;

  function write(relPath, content) {
    fs.mkdirSync(path.dirname(path.join(work, relPath)), { recursive: true });
    fs.writeFileSync(path.join(work, relPath), content);
  }

  function run() {
    return spawnSync(process.execPath, [SCRIPT_PATH, `--repo=${work}`], { encoding: 'utf8' });
  }

  const diagnosticLine = (result, where) => result.stderr.split('\n').find((line) => line.includes(where));

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'invisible-chars-jb5x-'));
    work = path.join(tmpRoot, 'work');
    fs.mkdirSync(work);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work, stdio: 'ignore' });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, RM_OPTIONS);
  });

  it('catches a literal U+202E in every newly covered path, in one run, worded for each file type', () => {
    const shellPaths = [
      'scripts/a.sh',
      '.claude/skills/x/hooks/a.sh',
      'harness/packs/x/hooks/a.sh',
      'test/e2e/fixtures/bin/bd',
      'test/e2e/fixtures/bin/claude',
    ];
    const yamlPaths = ['.github/workflows/ci.yml', '.github/dependabot.yml'];
    for (const relPath of [...shellPaths, ...yamlPaths]) write(relPath, `${cp(0x202e)}x\n`);
    const result = run();
    expect(result.status).toBe(EXIT_FOUND);
    expect(result.stderr).toContain(`${shellPaths.length + yamlPaths.length} 件を ${shellPaths.length + yamlPaths.length} ファイル`);
    expect(result.stderr).not.toContain(cp(0x202e));
    for (const relPath of shellPaths) {
      const line = diagnosticLine(result, `${relPath}:1:1 U+202E`);
      expect(line).toContain("$'");
      expect(line).not.toContain('JSX');
    }
    for (const relPath of yamlPaths) {
      const line = diagnosticLine(result, `${relPath}:1:1 U+202E`);
      expect(line).toContain('double-quoted');
      expect(line).not.toContain('JSX');
    }
  });

  it('does not look at the same file types outside their directories', () => {
    for (const relPath of [
      'docs/a.sh',
      'web/a.sh',
      '.claude/skills/x/a.md',
      'harness/packs/x/pack.json',
      '.agents/skills/beads/agents/openai.yaml',
      'workflows/ci.yml',
      'test/e2e/fixtures/bd/gate.list.json',
    ]) {
      write(relPath, `${cp(0x202e)}\n`);
    }
    expect(run().status).toBe(EXIT_OK);
  });

  it('names a variation selector after ASCII (with the emoji-only hint) and passes an emoji presentation selector', () => {
    write('src/a.ts', `const a = 'x${cp(VS16)}';\nconst warn = '${chars(WARNING, VS16)} careful';\n`);
    const result = run();
    expect(result.status).toBe(EXIT_FOUND);
    const line = diagnosticLine(result, 'src/a.ts:1:13 U+FE0F VARIATION SELECTOR-16');
    expect(line).toContain('right after an emoji');
    expect(line).toMatch(/^[\x20-\x7E]+$/);
    expect(result.stderr).not.toContain('src/a.ts:2');
    expect(result.stderr).toContain('1 件を 1 ファイル');
  });

  it('passes a file whose only variation selector is an emoji presentation selector', () => {
    write('scripts/guard.mjs', `export const message = '${chars(WARNING, VS16)} bd prime is blocked';\n`);
    write('src/keys.ts', `export const key = '${chars(0x31, VS16, KEYCAP)}';\n`);
    expect(run().status).toBe(EXIT_OK);
  });

  it.each([
    ['UTF-16LE', (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])],
    ['UTF-16BE', (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])],
  ])('tells a %s file to be saved again as UTF-8 instead of to write an escape', (_label, encode) => {
    write('src/utf16.ts', encode(`export const s = '${cp(0x202e)}';\n`));
    const result = run();
    expect(result.status).toBe(EXIT_FOUND);
    for (const where of ['src/utf16.ts:1:1 U+FEFF', 'src/utf16.ts:1:20 U+202E']) {
      const line = diagnosticLine(result, where);
      expect(line).toContain('save it again as UTF-8 without a BOM');
      expect(line).not.toContain('escape');
      expect(line).not.toContain('JSX');
    }
  });

  it('still gives the escape advice (not the UTF-8 advice) for the same content saved as UTF-8', () => {
    write('src/utf8.ts', `export const s = '${cp(0x202e)}';\n`);
    const line = diagnosticLine(run(), 'src/utf8.ts:1:19 U+202E');
    expect(line).toContain('escape');
    expect(line).not.toContain('UTF-16');
    expect(line).not.toContain('save it again');
  });
});
