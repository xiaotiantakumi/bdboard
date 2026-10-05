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
import { LINEAR_TIME_TEST_TIMEOUT_MS, expectLinearTime } from './linear-time-test-support.js';

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

describe('ANSI escape sequences are removed whole, not just the ESC character', () => {
  // ESC・BEL・U+009B は実行時に作る (テストの文字列リテラルに制御文字を直接書かない)。
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CSI8 = String.fromCharCode(0x9b);
  const BS = '\\';

  it.each([
    ['colour on and off', `${ESC}[36m/Users/jdoe/x${ESC}[39m`, '/Users/jdoe/x'],
    ['a two-parameter colour', `a ${ESC}[1;31mFAIL${ESC}[0m b`, 'a FAIL b'],
    ['erase in line', `${ESC}[K/home/jdoe/x`, '/home/jdoe/x'],
    ['a cursor move with a private marker', `${ESC}[?25lC:${BS}Users${BS}jdoe`, `C:${BS}Users${BS}jdoe`],
    ['a sequence with an intermediate byte', `${ESC}[2 qx`, 'x'],
    ['an OSC title ended by BEL', `${ESC}]0;title of window${BEL}/Users/jdoe/x`, '/Users/jdoe/x'],
    ['an OSC hyperlink ended by ESC backslash', `${ESC}]8;;file:///x${ESC}${BS}link${ESC}]8;;${ESC}${BS}`, 'link'],
    ['an 8-bit CSI', `${CSI8}36m/Users/jdoe/x`, '/Users/jdoe/x'],
    ['the JSON form \\u001b', `${BS}u001b[36m/Users/jdoe/x${BS}u001b[39m`, '/Users/jdoe/x'],
    ['the JSON form with an upper-case hex digit', `${BS}u001B[36mx`, 'x'],
    ['the log form \\x1b', `${BS}x1b[36mx`, 'x'],
    ['the shell form \\033', `${BS}033[36mx${BS}033[0m`, 'x'],
    ['the shell form \\e', `${BS}e[1;32mx`, 'x'],
  ])('removes %s (in a one-line value and in a block)', (_name, text, expected) => {
    expect(normalizeInline(text)).toBe(expected);
    expect(normalizeBlock(text)).toBe(expected);
  });

  it('does not remove an unfinished sequence or ordinary brackets', () => {
    expect(normalizeInline(`${ESC}]0;no terminator`)).toBe(']0;no terminator');
    expect(normalizeInline('a[0] = [36m b')).toBe('a[0] = [36m b');
    expect(normalizeInline(`${BS}u0041[36m`)).toBe(`${BS}u0041[36m`);
  });

  it.each([
    ['ESC [ and a POSIX home path', `x ${ESC}[/Users/jdoe/x`, 'x [/Users/jdoe/x'],
    ['ESC [ and a lower-case home path', `x ${ESC}[/home/jdoe/x`, 'x [/home/jdoe/x'],
    ['ESC [ , a space and a home path', `x ${ESC}[ /Users/jdoe/x`, 'x [ /Users/jdoe/x'],
    ['an 8-bit CSI and a home path', `x${CSI8}/Users/jdoe/x`, 'x/Users/jdoe/x'],
    ['the shell form \\e[ and a space and a home path', `echo ${BS}e[ /Users/jdoe/x`, `echo ${BS}e[ /Users/jdoe/x`],
    ['ESC [ and a drive letter that looks like a cursor-forward', `x ${ESC}[C:${BS}Users${BS}jdoe${BS}x`, `x [C:${BS}Users${BS}jdoe${BS}x`],
    ['ESC [ and a drive letter with a slash', `x ${ESC}[C:/Users/jdoe/x`, 'x [C:/Users/jdoe/x'],
    ['the 8-bit CSI and a drive letter', `x${CSI8}C:${BS}Users${BS}jdoe`, `xC:${BS}Users${BS}jdoe`],
  ])('keeps the whole path that follows a broken sequence: %s', (_name, text, expected) => {
    expect(normalizeInline(text)).toBe(expected);
    expect(normalizeBlock(text)).toBe(expected);
  });

  it('still removes a real cursor movement whose final byte is a letter', () => {
    expect(normalizeInline(`a${ESC}[Cb`)).toBe('ab');
    expect(normalizeInline(`a${ESC}[12Cb`)).toBe('ab');
    expect(normalizeInline(`a${ESC}[2Kb${ESC}[1;5Hc`)).toBe('abc');
  });

  it.each([
    ['select ASCII (tput sgr0)', `${ESC}(B`, ''],
    ['select a line-drawing set', `${ESC})0x`, 'x'],
    ['save cursor', `${ESC}7x`, 'x'],
    ['restore cursor', `${ESC}8x`, 'x'],
    ['keypad mode on', `${ESC}=x`, 'x'],
    ['keypad mode off', `${ESC}>x`, 'x'],
    ['tput sgr0 then a reset then a home path', `Error:${ESC}(B${ESC}[m/Users/jdoe/x`, 'Error:/Users/jdoe/x'],
  ])('removes the two-character escape: %s', (_name, text, expected) => {
    expect(normalizeInline(text)).toBe(expected);
    expect(normalizeBlock(text)).toBe(expected);
  });

  it('does not take the first character of a path as the second character of an escape', () => {
    for (const path of ['/Users/jdoe/x', 'Users/jdoe', `C:${BS}Users${BS}jdoe`, '~/x', 'c:/users/jdoe', '{x}']) {
      expect(normalizeInline(`${ESC}${path}`)).toBe(path);
    }
  });

  // bdboard-0101: 壁時計の絶対値 (3000ms) ではなく、同じ形を 1/10 の長さと元の長さで測った比で線形を見る。
  it('stays linear on 100k of escape-like text', () => {
    expectLinearTime('issue-public-text: escape-like 100k text', (n) => {
      const hostile = [
        `${ESC}[`.repeat(n(50_000)),
        `${ESC}[1`.repeat(n(30_000)),
        `${ESC}]0;`.repeat(n(25_000)),
        `${ESC}]` + 'x'.repeat(n(100_000)),
        `${ESC}[` + '1;'.repeat(n(50_000)),
        `${BS}u001b[`.repeat(n(15_000)),
        `${BS}e[`.repeat(n(30_000)),
        `${ESC}[/`.repeat(n(40_000)),
        `${ESC}[C:${BS}`.repeat(n(25_000)),
        `${ESC}(`.repeat(n(50_000)),
        `${ESC}[ `.repeat(n(30_000)),
      ];
      return () => {
        for (const value of hostile) {
          normalizeInline(value);
          normalizeBlock(value);
        }
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);
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
  // bdboard-0101: 壁時計の絶対値 (3000ms) ではなく、同じ形を 1/10 の長さと元の長さで測った比で線形を見る。
  it('normalizes long runs of whitespace, blank lines, tabs and invisible text in linear time', () => {
    expectLinearTime('issue-public-text: whitespace and invisible 100k text', (n) => {
      const hostile = [
        ' '.repeat(n(100_000)) + 'x',
        '\n'.repeat(n(100_000)) + 'x',
        'x' + '\n'.repeat(n(100_000)),
        '\t'.repeat(n(100_000)) + 'x',
        String.fromCodePoint(0xa0).repeat(n(100_000)) + 'x',
        'a '.repeat(n(50_000)),
        ' \n'.repeat(n(50_000)) + 'x',
        HIGH.repeat(n(100_000)),
        PAIR.repeat(n(50_000)),
        ZWSP.repeat(n(100_000)),
      ];
      return () => {
        for (const value of hostile) {
          normalizeInline(value);
          normalizeBlock(value);
          removeLoneSurrogates(value);
          codePointLength(value);
        }
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);
});
