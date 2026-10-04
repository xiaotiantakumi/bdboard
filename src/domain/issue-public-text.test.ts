import { describe, expect, it } from 'vitest';
import {
  codePointLength,
  codeUnitIndexAfterCodePoints,
  codeUnitIndexBeforeTailCodePoints,
  cutCodePointsHead,
  normalizeBlock,
  normalizeInline,
  removeLoneSurrogates,
} from './issue-public-text.js';

// 孤立サロゲートや行区切りは、テストの文字列リテラルに直接書かず実行時に組み立てる (ツールやエディタに壊されないため)。
const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde00);
const PAIR = HIGH + LOW;
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);
const NEL = String.fromCodePoint(0x85);
const VT = String.fromCodePoint(0x0b);
const FF = String.fromCodePoint(0x0c);
const ZWSP = String.fromCodePoint(0x200b);
const BIDI = String.fromCodePoint(0x202e);
const BOM = String.fromCodePoint(0xfeff);

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

describe('removeLoneSurrogates', () => {
  it.each([
    ['lone high at the head', HIGH + 'abc', 'abc'],
    ['lone low at the head', LOW + 'abc', 'abc'],
    ['lone high in the middle', 'a' + HIGH + 'b', 'ab'],
    ['lone low in the middle', 'a' + LOW + 'b', 'ab'],
    ['lone high at the tail', 'abc' + HIGH, 'abc'],
    ['lone low at the tail', 'abc' + LOW, 'abc'],
    ['an extra high before a valid pair', HIGH + HIGH + LOW, PAIR],
    ['an extra low after a valid pair', PAIR + LOW, PAIR],
    ['low then high (both invalid)', LOW + HIGH, ''],
    ['two highs', HIGH + HIGH, ''],
    ['two lows', LOW + LOW, ''],
    ['valid pairs are kept', 'x' + PAIR + PAIR + 'y', 'x' + PAIR + PAIR + 'y'],
    ['pairs next to invalid halves', HIGH + PAIR + LOW + PAIR + HIGH, PAIR + PAIR],
  ])('%s', (_name, input, expected) => {
    const output = removeLoneSurrogates(input);
    expect(output).toBe(expected);
    expect(isWellFormed(output)).toBe(true);
  });

  it('makes every prefix, suffix and mixed slice of a surrogate-heavy string well-formed', () => {
    const source = (PAIR + HIGH + LOW + 'a' + LOW + HIGH + HIGH).repeat(3);
    for (let start = 0; start < source.length; start += 1) {
      expect(isWellFormed(removeLoneSurrogates(source.slice(start)))).toBe(true);
      expect(isWellFormed(removeLoneSurrogates(source.slice(0, start)))).toBe(true);
    }
  });
});

describe('normalizeInline', () => {
  it('turns every line break and tab into one space and trims', () => {
    const input = ['  a', '\r\n', 'b', '\r', 'c', '\n', 'd', '\t', 'e', LS, 'f', PS, 'g', NEL, 'h', VT, 'i', FF, 'j  '].join('');
    expect(normalizeInline(input)).toBe('a b c d e f g h i j');
  });

  it('collapses runs of spaces and drops invisible and bidi characters without adding spaces', () => {
    expect(normalizeInline('a   b' + ZWSP + 'c' + BIDI + 'd' + BOM)).toBe('a bcd');
  });

  it('removes lone surrogates first and keeps valid pairs', () => {
    const output = normalizeInline(HIGH + 'a' + PAIR + LOW + ' b' + HIGH);
    expect(output).toBe('a' + PAIR + ' b');
    expect(isWellFormed(output)).toBe(true);
  });

  it('returns an empty string for text that is only invisible or blank', () => {
    expect(normalizeInline(' \n\t' + ZWSP + HIGH + ' ')).toBe('');
  });
});

describe('normalizeBlock', () => {
  it('unifies every line break kind to LF', () => {
    const input = ['a', '\r\n', 'b', '\r', 'c', LS, 'd', PS, 'e', NEL, 'f', VT, 'g', FF, 'h'].join('');
    expect(normalizeBlock(input)).toBe('a\nb\nc\nd\ne\nf\ng\nh');
  });

  it('turns tabs into two spaces, keeps indentation, trims line ends and outer blank lines', () => {
    expect(normalizeBlock('  \n\n\tfoo  \n   bar\t\n\n \n')).toBe('  foo\n   bar');
  });

  it('keeps interior blank lines and strips invisible characters per line', () => {
    expect(normalizeBlock('a' + ZWSP + 'b\n \n\nc' + BIDI)).toBe('ab\n\n\nc');
  });

  it('returns an empty string for blank text and removes lone surrogates', () => {
    expect(normalizeBlock(' \n\t\n' + HIGH + '\n ')).toBe('');
    const output = normalizeBlock('x' + HIGH + '\n' + LOW + 'y\n' + PAIR);
    expect(output).toBe('x\ny\n' + PAIR);
    expect(isWellFormed(output)).toBe(true);
  });
});

describe('code point helpers', () => {
  const value = 'a' + PAIR + 'b';

  it('counts code points', () => {
    expect(codePointLength('')).toBe(0);
    expect(codePointLength(value)).toBe(3);
  });

  it('finds head and tail cut offsets on code point boundaries', () => {
    expect(codeUnitIndexAfterCodePoints(value, 0)).toBe(0);
    expect(codeUnitIndexAfterCodePoints(value, 1)).toBe(1);
    expect(codeUnitIndexAfterCodePoints(value, 2)).toBe(3);
    expect(codeUnitIndexAfterCodePoints(value, 99)).toBe(value.length);
    expect(codeUnitIndexBeforeTailCodePoints(value, 0)).toBe(value.length);
    expect(codeUnitIndexBeforeTailCodePoints(value, 1)).toBe(3);
    expect(codeUnitIndexBeforeTailCodePoints(value, 2)).toBe(1);
    expect(codeUnitIndexBeforeTailCodePoints(value, 99)).toBe(0);
  });

  it('never splits a surrogate pair at any cut length', () => {
    const source = (PAIR + 'a').repeat(6);
    for (let count = 0; count <= 14; count += 1) {
      expect(isWellFormed(cutCodePointsHead(source, count))).toBe(true);
      expect(isWellFormed(source.slice(codeUnitIndexBeforeTailCodePoints(source, count)))).toBe(true);
    }
    expect(cutCodePointsHead(value, 2)).toBe('a' + PAIR);
  });
});

describe('linear time on hostile 100k inputs', () => {
  it('normalizes long runs of whitespace, blank lines, tabs and invisible text quickly', () => {
    const hostile = [
      ' '.repeat(100_000) + 'x',
      '\n'.repeat(100_000) + 'x',
      'x' + '\n'.repeat(100_000),
      '\t'.repeat(100_000) + 'x',
      String.fromCodePoint(0xa0).repeat(100_000) + 'x',
      'a '.repeat(50_000),
      ' \n'.repeat(50_000) + 'x',
      HIGH.repeat(100_000),
      PAIR.repeat(50_000),
      ZWSP.repeat(100_000),
    ];
    const started = performance.now();
    for (const value of hostile) {
      normalizeInline(value);
      normalizeBlock(value);
      removeLoneSurrogates(value);
      codePointLength(value);
    }
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
