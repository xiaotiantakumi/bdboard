import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import eslintConfig from '../eslint.config.mjs';

import {
  CONFIG_RELATIVE_PATH,
  EXIT_FOUND,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  buildFileRecords,
  countLines,
  evaluate,
  formatResult,
  isFixturePath,
  isTargetPath,
  isTestPath,
  listGitFiles,
  parseBaselineConfig,
  validateEntryShape,
} from './check-file-size.mjs';
import * as CheckFileSizeModule from './check-file-size.mjs';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-file-size.mjs');

// ---- export surface: bdboard-sso1.58 のモジュール分割で公開面が変わっていないことの固定 ----
describe('check-file-size.mjs export surface', () => {
  it('exposes exactly the expected public API', () => {
    expect(Object.keys(CheckFileSizeModule).sort()).toEqual(
      [
        'CONFIG_RELATIVE_PATH',
        'EXIT_FOUND',
        'EXIT_OK',
        'EXIT_UNAVAILABLE',
        'TARGET_DIRS',
        'TARGET_EXTENSIONS',
        'buildFileRecords',
        'countLines',
        'evaluate',
        'formatResult',
        'isFixturePath',
        'isTargetPath',
        'isTestPath',
        'listGitFiles',
        'parseBaselineConfig',
        'parseCliArgs',
        'validateEntryShape',
      ].sort(),
    );
  });
});

// ---- countLines: CRLF/LF/CR/空/末尾改行なしで同じ値になること ----
describe('countLines', () => {
  it('counts LF-separated lines', () => {
    expect(countLines('a\nb\nc\n')).toBe(3);
  });

  it('counts CRLF-separated lines identically to LF', () => {
    expect(countLines('a\r\nb\r\nc\r\n')).toBe(3);
    expect(countLines('a\r\nb\r\nc\r\n')).toBe(countLines('a\nb\nc\n'));
  });

  it('counts bare-CR-separated lines identically to LF', () => {
    expect(countLines('a\rb\rc\r')).toBe(countLines('a\nb\nc\n'));
  });

  it('counts the final line even without a trailing newline', () => {
    expect(countLines('a\nb\nc')).toBe(3);
  });

  it('returns 0 for an empty file', () => {
    expect(countLines('')).toBe(0);
  });

  it('returns 1 for a single line without a trailing newline', () => {
    expect(countLines('a')).toBe(1);
  });
});

// ---- isTargetPath: 対象ディレクトリ x 対象拡張子。似た名前のディレクトリと衝突しないこと ----
// bdboard-sso1.8: src/ web/src/ scripts/ の行数上限は eslint.config.mjs の max-lines に
// 一本化した。ただし対象拡張子はディレクトリごとに違う (bdboard-hncr:
// src→.ts のみ、web/src→.ts/.tsx、scripts→.mjs のみ。classify.mjs の
// ESLINT_COVERED_EXTENSIONS_BY_DIR 参照)。この3ディレクトリではそれぞれの対象拡張子が
// このガードの対象外になり、それ以外の組み合わせ (.js/.mjs が src/ にある等) と、
// ESLint が見ない拡張子 (.css 等) は引き続きここで見る。harness/ と test/ は ESLint が
// 見ないため、引き続き全対象拡張子を見る。
describe('isTargetPath', () => {
  it.each([
    ['src/foo.js', true], // ESLint (src/**/*.ts のみ) は .js を見ない
    ['src/foo.mjs', true],
    ['web/src/foo.js', true], // ESLint (web/src/**/*.{ts,tsx}) は .js/.mjs を見ない
    ['web/src/foo.mjs', true],
    ['scripts/foo.ts', true], // ESLint (scripts/**/*.mjs のみ) は .ts を見ない
    ['scripts/foo.js', true],
  ])('%s -> %s (eslint config gap, must stay covered by check-file-size)', (p, expected) => {
    expect(isTargetPath(p)).toBe(expected);
  });

  it.each([
    ['web/src/foo.css', true], // ESLint が見ない拡張子は引き続き対象
    ['scripts/foo.sh', true], // scripts/ でも .sh は ESLint 対象外 (実在しないが仕様上は対象)
    ['harness/packs/x/foo.sh', true], // harness/ は ESLint の ignores 対象、全拡張子を見る
    ['harness/packs/x/foo.ts', true],
    ['test/e2e/foo.ts', true], // test/ は ESLint の lint 対象外、引き続き .ts も見る
    ['test/e2e/foo.tsx', true],
  ])('%s -> %s (matches)', (p, expected) => {
    expect(isTargetPath(p)).toBe(expected);
  });

  it.each([
    ['src/foo.ts', false], // ESLint (src/**/*.ts) が見るため対象外
    ['src/nested/foo.tsx', true], // src/**/*.tsx は ESLint max-lines の対象外
    ['web/src/foo.tsx', false], // ESLint (web/src/**/*.tsx) が見るため対象外
    ['scripts/foo.mjs', false], // ESLint (scripts/**/*.mjs) が見るため対象外
    ['srcfoo/bar.ts', false], // ディレクトリ名の前方一致誤爆
    ['testing/bar.ts', false], // 'test' の前方一致誤爆
    ['websrc/bar.ts', false],
    ['src/foo.txt', false], // 対象外拡張子
    ['src/foo.json', false],
    ['README.md', false],
    ['docs/VERIFY.md', false],
    ['src', false], // ディレクトリそのもの (拡張子なし)
  ])('%s -> %s (does not match)', (p, expected) => {
    expect(isTargetPath(p)).toBe(expected);
  });

  it('does not confuse .ts with .tsx (in a dir ESLint does not cover)', () => {
    expect(isTargetPath('test/e2e/foo.tsx')).toBe(true);
    expect(isTargetPath('test/e2e/foo.ts')).toBe(true);
    expect(isTargetPath('test/e2e/foo.tsxx')).toBe(false);
  });

  it('excludes ESLint-covered extensions only inside src/, web/src/, scripts/', () => {
    expect(isTargetPath('src/foo.ts')).toBe(false);
    expect(isTargetPath('web/src/foo.ts')).toBe(false);
    expect(isTargetPath('scripts/foo.mjs')).toBe(false);
    // 同じ拡張子でも ESLint が見ない harness/ test/ では引き続き対象。
    expect(isTargetPath('harness/foo.ts')).toBe(true);
    expect(isTargetPath('test/foo.ts')).toBe(true);
  });
});

describe('eslint.config.mjs drift guard (bdboard-hncr)', () => {
  it('keeps the max-lines-covered file globs in sync with classify.mjs\'s per-dir map', () => {
    const maxLinesEntry = eslintConfig.find(
      (entry) =>
        Array.isArray(entry.files) &&
        entry.rules?.['max-lines'] !== undefined &&
        entry.files.length === 3,
    );
    expect(maxLinesEntry).toBeDefined();
    // If this changes, update classify.mjs ESLINT_COVERED_EXTENSIONS_BY_DIR too.
    expect(maxLinesEntry.files).toEqual([
      'src/**/*.ts',
      'web/src/**/*.{ts,tsx}',
      'scripts/**/*.mjs',
    ]);
  });
});

// ---- isTestPath ----
describe('isTestPath', () => {
  it.each([
    ['src/foo.test.ts', true],
    ['web/src/Foo.test.tsx', true],
    ['scripts/foo.spec.mjs', true],
    ['src/foo.ts', false],
    ['src/testing.ts', false], // 'test' の部分文字列誤爆禁止
    ['src/latest.ts', false],
    ['src/foo.test.d.ts', false], // 拡張子側に追加のドットがあるケースは対象外
  ])('%s -> %s', (p, expected) => {
    expect(isTestPath(p)).toBe(expected);
  });
});

// ---- isFixturePath ----
describe('isFixturePath', () => {
  it.each([
    ['src/fixtures/foo.ts', true],
    ['fixtures/foo.ts', true],
    ['src/a/fixtures/b/foo.ts', true],
    ['src/fixtures-data/foo.ts', false], // セグメント一致のみ、部分一致は誤爆させない
    ['src/myfixtures/foo.ts', false],
    ['src/foo.ts', false],
  ])('%s -> %s', (p, expected) => {
    expect(isFixturePath(p)).toBe(expected);
  });
});

// ---- parseBaselineConfig: fail-closed の検証 ----
describe('parseBaselineConfig', () => {
  const valid = () =>
    JSON.stringify({
      defaultLimits: { nonTest: 500, test: 1500 },
      ratchetWarningThreshold: 200,
      entries: [{ path: 'test/big.ts', limit: 600, reason: '理由 (bdboard-test1)' }],
    });

  it('parses a valid config', () => {
    const config = parseBaselineConfig(valid());
    expect(config.defaultLimits).toEqual({ nonTest: 500, test: 1500 });
    expect(config.ratchetWarningThreshold).toBe(200);
    expect(config.entries.get('test/big.ts')).toEqual({ limit: 600, reason: '理由 (bdboard-test1)' });
  });

  it('throws on broken JSON syntax', () => {
    expect(() => parseBaselineConfig('{not json')).toThrow(/構文が壊れています/);
  });

  it('throws when the top level is not an object', () => {
    expect(() => parseBaselineConfig('[]')).toThrow(/トップレベルがオブジェクト/);
  });

  it('throws when defaultLimits is missing or non-integer', () => {
    const bad = JSON.parse(valid());
    bad.defaultLimits.nonTest = 0;
    expect(() => parseBaselineConfig(JSON.stringify(bad))).toThrow(/defaultLimits/);
  });

  it('throws when ratchetWarningThreshold is missing', () => {
    const bad = JSON.parse(valid());
    delete bad.ratchetWarningThreshold;
    expect(() => parseBaselineConfig(JSON.stringify(bad))).toThrow(/ratchetWarningThreshold/);
  });

  it('throws when entries is not an array', () => {
    const bad = JSON.parse(valid());
    bad.entries = {};
    expect(() => parseBaselineConfig(JSON.stringify(bad))).toThrow(/entries は配列/);
  });

  it('throws when an entry path uses a backslash (Windows対策)', () => {
    const bad = JSON.parse(valid());
    bad.entries[0].path = 'src\\big.ts';
    expect(() => parseBaselineConfig(JSON.stringify(bad))).toThrow(/バックスラッシュ/);
  });

  it('throws when an entry path is not normalized', () => {
    const bad = JSON.parse(valid());
    bad.entries[0].path = 'src/../src/big.ts';
    expect(() => parseBaselineConfig(JSON.stringify(bad))).toThrow(/正規化/);
  });

  it('throws when an entry path is absolute', () => {
    const bad = JSON.parse(valid());
    bad.entries[0].path = '/src/big.ts';
    expect(() => parseBaselineConfig(JSON.stringify(bad))).toThrow(/正規化/);
  });

  it('throws when an entry path is outside the target scope', () => {
    const bad = JSON.parse(valid());
    bad.entries[0].path = 'src/README.md';
    expect(() => parseBaselineConfig(JSON.stringify(bad))).toThrow(/対象範囲外/);
  });

  it('throws when limit is not a positive integer', () => {
    const bad = JSON.parse(valid());
    bad.entries[0].limit = 0;
    expect(() => parseBaselineConfig(JSON.stringify(bad))).toThrow(/limit/);
  });

  it('throws when limit is not an integer (float)', () => {
    const bad = JSON.parse(valid());
    bad.entries[0].limit = 600.5;
    expect(() => parseBaselineConfig(JSON.stringify(bad))).toThrow(/limit/);
  });

  it('throws when reason is empty', () => {
    const bad = JSON.parse(valid());
    bad.entries[0].reason = '   ';
    expect(() => parseBaselineConfig(JSON.stringify(bad))).toThrow(/reason は空にできません/);
  });

  it('throws when reason has no ticket ID', () => {
    const bad = JSON.parse(valid());
    bad.entries[0].reason = '理由のみ';
    expect(() => parseBaselineConfig(JSON.stringify(bad))).toThrow(/チケット ID/);
  });

  it('throws on duplicate paths', () => {
    const bad = JSON.parse(valid());
    bad.entries.push({ path: 'test/big.ts', limit: 700, reason: '別の理由 (bdboard-test2)' });
    expect(() => parseBaselineConfig(JSON.stringify(bad))).toThrow(/重複しています/);
  });

  it('reports every malformed entry at once, not just the first', () => {
    const bad = JSON.parse(valid());
    bad.entries.push({ path: 'src/other.ts', limit: -1, reason: '' });
    try {
      parseBaselineConfig(JSON.stringify(bad));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.message).toContain('entries[1].limit');
      expect(error.message).toContain('entries[1].reason');
    }
  });
});

describe('validateEntryShape', () => {
  it('accepts a well-formed entry', () => {
    expect(validateEntryShape({ path: 'test/a/b.ts', limit: 10, reason: 'x (bdboard-test7)' }, 0)).toEqual([]);
  });

  it('rejects a non-object entry', () => {
    expect(validateEntryShape('nope', 0)).toEqual(['entries[0] はオブジェクトである必要があります']);
  });

  it.each(['docs/foo.ts', 'src/README.md', 'src/fixtures/big.ts'])(
    'rejects out-of-scope path %s',
    (entryPath) => {
      expect(validateEntryShape({ path: entryPath, limit: 10, reason: 'x (bdboard-test8)' }, 0)).toEqual([
        `entries[0].path (${entryPath}) は対象範囲外です (対象ディレクトリ/拡張子外、または fixtures/ 配下は baseline に登録できません)`,
      ]);
    },
  );

  // src/fixtures/big.ts は ESLint 対象拡張子 (.ts in src/) の除外だけでも isTargetPath が
  // false になるため、上のケースだけでは isFixturePath 側の OR 分岐を検証できない
  // (isFixturePath チェックを消しても通ってしまう)。test/ は ESLint 対象外で .ts も
  // 対象拡張子なので isTargetPath は true になり、fixtures/ 配下であることだけを理由に
  // 拒否されることを別途確認する。
  it('rejects a fixtures/ path that is otherwise in scope (isFixturePath branch)', () => {
    expect(validateEntryShape({ path: 'test/fixtures/big.ts', limit: 10, reason: 'x (bdboard-test9)' }, 0)).toEqual([
      'entries[0].path (test/fixtures/big.ts) は対象範囲外です (対象ディレクトリ/拡張子外、または fixtures/ 配下は baseline に登録できません)',
    ]);
  });

  it.each(['src\\big.ts', 'src/../src/big.ts'])('does not scope-check malformed path %s', (entryPath) => {
    const errors = validateEntryShape({ path: entryPath, limit: 10, reason: 'x' }, 0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain('対象範囲外');
  });
});

// ---- evaluate: (a)〜(d) の境界を厳密に確認する (ミューテーション耐性のため境界値を必ず張る) ----
describe('evaluate', () => {
  const config = (overrides = {}) => ({
    defaultLimits: { nonTest: 100, test: 300 },
    ratchetWarningThreshold: 20,
    entries: new Map(),
    ...overrides,
  });

  it('(ok) a new non-test file at exactly the default limit passes', () => {
    const result = evaluate([{ path: 'src/a.ts', isTest: false, lines: 100 }], config());
    expect(result.newOverLimit).toEqual([]);
    expect(result.ok).toHaveLength(1);
  });

  it('(a) a new non-test file one line over the default limit fails', () => {
    const result = evaluate([{ path: 'src/a.ts', isTest: false, lines: 101 }], config());
    expect(result.newOverLimit).toEqual([{ path: 'src/a.ts', lines: 101, defaultLimit: 100 }]);
  });

  it('(a) test files use the test default limit, not the non-test one', () => {
    const result = evaluate([{ path: 'src/a.test.ts', isTest: true, lines: 250 }], config());
    expect(result.newOverLimit).toEqual([]);
    const over = evaluate([{ path: 'src/a.test.ts', isTest: true, lines: 301 }], config());
    expect(over.newOverLimit).toHaveLength(1);
  });

  it('(ok) a baselined file at exactly its own limit passes', () => {
    const entries = new Map([['src/a.ts', { limit: 150, reason: 'r' }]]);
    const result = evaluate([{ path: 'src/a.ts', isTest: false, lines: 150 }], config({ entries }));
    expect(result.overOwnLimit).toEqual([]);
    expect(result.ok).toHaveLength(1);
  });

  it('(b) a baselined file one line over its own limit fails', () => {
    const entries = new Map([['src/a.ts', { limit: 150, reason: 'r' }]]);
    const result = evaluate([{ path: 'src/a.ts', isTest: false, lines: 151 }], config({ entries }));
    expect(result.overOwnLimit).toEqual([{ path: 'src/a.ts', lines: 151, limit: 150 }]);
  });

  it('(c) a baselined file that shrank to exactly the default limit must be dropped', () => {
    const entries = new Map([['src/a.ts', { limit: 150, reason: 'r' }]]);
    const result = evaluate([{ path: 'src/a.ts', isTest: false, lines: 100 }], config({ entries }));
    expect(result.shrunkBelowDefault).toEqual([
      { path: 'src/a.ts', lines: 100, limit: 150, defaultLimit: 100 },
    ]);
  });

  it('(ok) a baselined file one line above the default limit is not "shrunk"', () => {
    const entries = new Map([['src/a.ts', { limit: 150, reason: 'r' }]]);
    const result = evaluate([{ path: 'src/a.ts', isTest: false, lines: 101 }], config({ entries }));
    expect(result.shrunkBelowDefault).toEqual([]);
    expect(result.ok).toHaveLength(1);
  });

  it('(c) a baseline entry whose file is absent from the scan is reported missing', () => {
    const entries = new Map([['src/gone.ts', { limit: 150, reason: 'r' }]]);
    const result = evaluate([], config({ entries }));
    expect(result.missingFiles).toEqual([{ path: 'src/gone.ts', limit: 150 }]);
  });

  it('(d) warns exactly at the ratchet threshold, not one below it', () => {
    const entries = new Map([['src/a.ts', { limit: 150, reason: 'r' }]]);
    // gap = 150 - 130 = 20 == threshold(20) -> warn
    const atThreshold = evaluate([{ path: 'src/a.ts', isTest: false, lines: 130 }], config({ entries }));
    expect(atThreshold.ratchetWarnings).toEqual([
      { path: 'src/a.ts', lines: 130, limit: 150, gap: 20 },
    ]);
    // gap = 150 - 131 = 19 < threshold(20) -> no warning
    const belowThreshold = evaluate(
      [{ path: 'src/a.ts', isTest: false, lines: 131 }],
      config({ entries }),
    );
    expect(belowThreshold.ratchetWarnings).toEqual([]);
  });

  it('a file exceeding its own baseline limit is reported as (b), not also as a ratchet warning', () => {
    const entries = new Map([['src/a.ts', { limit: 150, reason: 'r' }]]);
    const result = evaluate([{ path: 'src/a.ts', isTest: false, lines: 200 }], config({ entries }));
    expect(result.overOwnLimit).toHaveLength(1);
    expect(result.ratchetWarnings).toEqual([]);
  });

  it('classifies multiple independent files correctly in one pass', () => {
    const entries = new Map([
      ['src/over.ts', { limit: 150, reason: 'r' }],
      ['src/shrunk.ts', { limit: 150, reason: 'r' }],
      ['src/missing.ts', { limit: 150, reason: 'r' }],
    ]);
    const result = evaluate(
      [
        { path: 'src/new.ts', isTest: false, lines: 101 },
        { path: 'src/over.ts', isTest: false, lines: 151 },
        { path: 'src/shrunk.ts', isTest: false, lines: 50 },
        { path: 'src/fine.ts', isTest: false, lines: 50 },
      ],
      config({ entries }),
    );
    expect(result.newOverLimit.map((f) => f.path)).toEqual(['src/new.ts']);
    expect(result.overOwnLimit.map((f) => f.path)).toEqual(['src/over.ts']);
    expect(result.shrunkBelowDefault.map((f) => f.path)).toEqual(['src/shrunk.ts']);
    expect(result.missingFiles.map((f) => f.path)).toEqual(['src/missing.ts']);
    expect(result.ok.map((r) => r.path)).toEqual(['src/fine.ts']);
  });
});

// ---- formatResult ----
describe('formatResult', () => {
  const config = () => ({
    defaultLimits: { nonTest: 100, test: 300 },
    ratchetWarningThreshold: 20,
    entries: new Map([['src/over.ts', { limit: 150, reason: 'r' }]]),
  });

  it('reports a clean pass with no findings', () => {
    const emptyConfig = { defaultLimits: { nonTest: 100, test: 300 }, ratchetWarningThreshold: 20, entries: new Map() };
    const text = formatResult(evaluate([{ path: 'src/ok.ts', isTest: false, lines: 10 }], emptyConfig));
    expect(text).toContain('巨大ファイルの新規発生・baseline 超過はありません');
    expect(text).not.toContain('docs/VERIFY.md');
  });

  it('omits the docs/VERIFY.md footer when only a (d) ratchet warning is present (non-fatal)', () => {
    const entries = new Map([['src/a.ts', { limit: 150, reason: 'r' }]]);
    const cfg = { defaultLimits: { nonTest: 100, test: 300 }, ratchetWarningThreshold: 20, entries };
    // 101 は既定上限(100)より上なので "ok" 枝に入り、gap = 150 - 101 = 49 >= threshold(20)
    // で (d) 警告だけが付く。newOverLimit/overOwnLimit/shrunkBelowDefault/missingFiles は
    // いずれも空 (total === 0、non-fatal) であること。
    const result = evaluate([{ path: 'src/a.ts', isTest: false, lines: 101 }], cfg);
    expect(
      result.newOverLimit.length +
        result.overOwnLimit.length +
        result.shrunkBelowDefault.length +
        result.missingFiles.length,
    ).toBe(0);
    const text = formatResult(result);
    expect(text).toContain('ラチェット');
    expect(text).not.toContain('docs/VERIFY.md');
  });

  it('includes actionable text for each failing category', () => {
    const entries = new Map([
      ['src/over.ts', { limit: 150, reason: 'r' }],
      ['src/shrunk.ts', { limit: 150, reason: 'r' }],
      ['src/missing.ts', { limit: 150, reason: 'r' }],
    ]);
    const cfg = { defaultLimits: { nonTest: 100, test: 300 }, ratchetWarningThreshold: 20, entries };
    const result = evaluate(
      [
        { path: 'src/new.ts', isTest: false, lines: 101 },
        { path: 'src/over.ts', isTest: false, lines: 151 },
        { path: 'src/shrunk.ts', isTest: false, lines: 50 },
      ],
      cfg,
    );
    const text = formatResult(result);
    expect(text).toContain('src/new.ts');
    expect(text).toContain(CONFIG_RELATIVE_PATH);
    expect(text).toContain('src/over.ts');
    expect(text).toContain('src/shrunk.ts');
    expect(text).toContain('src/missing.ts');
    expect(text).toMatch(/対処が要る項目が 4 件あります/);
    expect(text).toContain('docs/VERIFY.md');
    expect(text).toContain('ファイルサイズガード');
  });

  it('--report mode lists every scanned file sorted by line count descending', () => {
    const result = evaluate(
      [
        { path: 'src/small.ts', isTest: false, lines: 10 },
        { path: 'src/big.ts', isTest: false, lines: 90 },
      ],
      config(),
    );
    const text = formatResult(result, { report: true });
    const bigIndex = text.indexOf('src/big.ts');
    const smallIndex = text.indexOf('src/small.ts');
    expect(bigIndex).toBeGreaterThan(-1);
    expect(smallIndex).toBeGreaterThan(bigIndex);
  });
});

// ---- buildFileRecords: 実ファイルを読んで行数化する結線部分。fixtures 除外を含む ----
describe('buildFileRecords', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'file-size-records-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads real files and classifies test vs non-test', () => {
    fs.mkdirSync(path.join(tmpRoot, 'test'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'test', 'a.ts'), 'x\ny\n');
    fs.writeFileSync(path.join(tmpRoot, 'test', 'a.test.ts'), 'x\ny\nz\n');
    const records = buildFileRecords(tmpRoot, ['test/a.ts', 'test/a.test.ts']);
    expect(records).toEqual([
      { path: 'test/a.ts', isTest: false, lines: 2 },
      { path: 'test/a.test.ts', isTest: true, lines: 3 },
    ]);
  });

  it('excludes fixtures even when the path is otherwise a target', () => {
    fs.mkdirSync(path.join(tmpRoot, 'test', 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'test', 'fixtures', 'big.ts'), 'x\n'.repeat(10));
    const records = buildFileRecords(tmpRoot, ['test/fixtures/big.ts']);
    expect(records).toEqual([]);
  });

  it('silently skips a listed path that no longer exists on disk', () => {
    const records = buildFileRecords(tmpRoot, ['test/gone.ts']);
    expect(records).toEqual([]);
  });

  it('CRLF and LF files with the same content produce the same line count', () => {
    fs.mkdirSync(path.join(tmpRoot, 'test'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'test', 'lf.ts'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(tmpRoot, 'test', 'crlf.ts'), 'a\r\nb\r\nc\r\n');
    const records = buildFileRecords(tmpRoot, ['test/lf.ts', 'test/crlf.ts']);
    expect(records[0].lines).toBe(records[1].lines);
    expect(records[0].lines).toBe(3);
  });
});

// ---- CLI 統合テスト: 一時 git リポジトリで実行し、exit code と出力を確認する ----
describe('check-file-size CLI', () => {
  let tmpRoot;
  let work;

  function sh(cwd, ...args) {
    return execFileSync(args[0], args.slice(1), {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@e',
      },
    });
  }

  function writeConfig(overrides = {}) {
    const config = {
      defaultLimits: { nonTest: 5, test: 10 },
      ratchetWarningThreshold: 3,
      entries: [],
      ...overrides,
    };
    fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(work, CONFIG_RELATIVE_PATH), JSON.stringify(config));
  }

  function lines(n) {
    return `${'x\n'.repeat(n)}`;
  }

  function runCheck(args = []) {
    return spawnSync(process.execPath, [SCRIPT_PATH, `--repo=${work}`, ...args], {
      cwd: work,
      encoding: 'utf8',
    });
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'file-size-cli-'));
    work = path.join(tmpRoot, 'work');
    fs.mkdirSync(work, { recursive: true });
    sh(work, 'git', 'init', '-q', '-b', 'main');
    sh(work, 'git', 'config', 'user.name', 'T');
    sh(work, 'git', 'config', 'user.email', 't@e');
    sh(work, 'git', 'config', 'commit.gpgsign', 'false');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('exits 0 with no target files', () => {
    writeConfig();
    fs.writeFileSync(path.join(work, 'README.md'), '# hi\n');
    sh(work, 'git', 'add', '-A');
    sh(work, 'git', 'commit', '-qm', 'seed');
    const result = runCheck();
    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toContain('ありません');
  });

  it('(a) detects a new file over the default limit even before it is committed', () => {
    // git add すらしていない未追跡ファイルも拾えること (仕様: --cached --others の両方を見る)。
    writeConfig();
    fs.mkdirSync(path.join(work, 'test'), { recursive: true });
    fs.writeFileSync(path.join(work, 'test', 'big.ts'), lines(6));
    const result = runCheck();
    expect(result.status).toBe(EXIT_FOUND);
    expect(result.stdout).toContain('test/big.ts');
    expect(result.stdout).toContain('(a)');
    expect(result.stdout).toContain(CONFIG_RELATIVE_PATH);
  });

  it('(b) fails when a baselined file exceeds its own registered limit', () => {
    writeConfig({ entries: [{ path: 'test/big.ts', limit: 7, reason: 'test fixture (bdboard-test3)' }] });
    fs.mkdirSync(path.join(work, 'test'), { recursive: true });
    fs.writeFileSync(path.join(work, 'test', 'big.ts'), lines(8));
    sh(work, 'git', 'add', '-A');
    const result = runCheck();
    expect(result.status).toBe(EXIT_FOUND);
    expect(result.stdout).toContain('(b)');
    expect(result.stdout).toContain('test/big.ts');
  });

  it('(c) fails when a baselined file shrank back under the default limit', () => {
    writeConfig({ entries: [{ path: 'test/big.ts', limit: 7, reason: 'test fixture (bdboard-test3)' }] });
    fs.mkdirSync(path.join(work, 'test'), { recursive: true });
    fs.writeFileSync(path.join(work, 'test', 'big.ts'), lines(4));
    sh(work, 'git', 'add', '-A');
    const result = runCheck();
    expect(result.status).toBe(EXIT_FOUND);
    expect(result.stdout).toContain('(c)');
    expect(result.stdout).toContain('外してください');
  });

  it('(c) fails when a baselined file has been deleted / renamed away', () => {
    writeConfig({ entries: [{ path: 'test/gone.ts', limit: 7, reason: 'stale (bdboard-test4)' }] });
    fs.mkdirSync(path.join(work, 'test'), { recursive: true });
    fs.writeFileSync(path.join(work, 'test', 'other.ts'), lines(1));
    sh(work, 'git', 'add', '-A');
    const result = runCheck();
    expect(result.status).toBe(EXIT_FOUND);
    expect(result.stdout).toContain('test/gone.ts');
    expect(result.stdout).toContain('見つからない');
  });

  it('(d) warns without failing when the baseline has more than the ratchet threshold of slack', () => {
    // 既定上限 5、limit 9 -> 現行 6 行なら差 3 == threshold(3) で警告のみ、exit は 0。
    writeConfig({ entries: [{ path: 'test/big.ts', limit: 9, reason: 'slack (bdboard-test5)' }] });
    fs.mkdirSync(path.join(work, 'test'), { recursive: true });
    fs.writeFileSync(path.join(work, 'test', 'big.ts'), lines(6));
    sh(work, 'git', 'add', '-A');
    const result = runCheck();
    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toContain('(d)');
    expect(result.stdout).toContain('ラチェット');
  });

  it('produces the same line count for a CRLF-committed file as an LF one (verify-windows 対策)', () => {
    writeConfig();
    fs.mkdirSync(path.join(work, 'test'), { recursive: true });
    fs.writeFileSync(path.join(work, 'test', 'lf.ts'), lines(6));
    fs.writeFileSync(path.join(work, 'test', 'crlf.ts'), lines(6).replace(/\n/g, '\r\n'));
    sh(work, 'git', 'add', '-A');
    const result = runCheck(['--report']);
    // 両方とも 6 行として (a) に出るか、report テーブルに同じ行数で出る。
    const sixLineHits = (result.stdout.match(/^file-size:\s+6\t/gm) || []).length;
    expect(sixLineHits).toBeGreaterThanOrEqual(2);
  });

  it('exits 2 when the baseline config is malformed JSON', () => {
    fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(work, CONFIG_RELATIVE_PATH), '{not json');
    const result = runCheck();
    expect(result.status).toBe(EXIT_UNAVAILABLE);
    expect(result.stderr).toContain('baseline 設定を読み込めません');
  });

  it('exits 2 (not a permanent (c) failure) when a baseline entry points outside the target scope', () => {
    // bdboard-ihf6: 対象範囲外のパスを baseline に登録すると、走査結果に一度も現れず
    // 永久に (c) missing で fail し続けていた。CLI レベルでも早期の形式エラー (exit 2)
    // になることを固定する。
    writeConfig({ entries: [{ path: 'docs/foo.ts', limit: 5, reason: 'out of scope (bdboard-test6)' }] });
    const result = runCheck();
    expect(result.status).toBe(EXIT_UNAVAILABLE);
    expect(result.stderr).toContain('対象範囲外');
  });

  it('exits 2 when the baseline config file is missing entirely', () => {
    const result = runCheck();
    expect(result.status).toBe(EXIT_UNAVAILABLE);
  });

  it('--report lists all scanned files regardless of pass/fail', () => {
    writeConfig();
    fs.mkdirSync(path.join(work, 'test'), { recursive: true });
    fs.writeFileSync(path.join(work, 'test', 'ok.ts'), lines(2));
    sh(work, 'git', 'add', '-A');
    const result = runCheck(['--report']);
    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toContain('--report 一覧');
    expect(result.stdout).toContain('test/ok.ts');
  });
});

// ---- listGitFiles: 未追跡ファイルと無視ファイルの扱い ----
describe('listGitFiles', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'file-size-lsfiles-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpRoot });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('includes both committed and untracked-but-not-ignored files, POSIX-separated', () => {
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'src', 'a.ts'), '1\n');
    execFileSync('git', ['add', 'src/a.ts'], { cwd: tmpRoot });
    fs.writeFileSync(path.join(tmpRoot, 'src', 'b.ts'), '2\n');
    fs.writeFileSync(path.join(tmpRoot, '.gitignore'), 'ignored.ts\n');
    fs.writeFileSync(path.join(tmpRoot, 'src', 'ignored.ts'), '3\n');
    const files = listGitFiles(tmpRoot);
    expect(files).toContain('src/a.ts');
    expect(files).toContain('src/b.ts');
    expect(files).not.toContain('src/ignored.ts');
    for (const f of files) {
      expect(f).not.toContain('\\');
    }
  });

  it('returns non-ASCII filenames unquoted even when core.quotePath defaults to true', () => {
    // core.quotePath の *リポジトリローカル* な既定値を明示的に true にしておく
    // (グローバル設定が既に false の開発機では、-c を落としてもこのテストが偽陽性で
    // 通ってしまうため)。listGitFiles が -c core.quotePath=false / -z を正しく渡していれば、
    // ローカル設定の値に関わらずクォートされない。
    execFileSync('git', ['config', 'core.quotePath', 'true'], { cwd: tmpRoot });
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'src', '日本語.ts'), '1\n');
    expect(listGitFiles(tmpRoot)).toContain('src/日本語.ts');
  });
});
