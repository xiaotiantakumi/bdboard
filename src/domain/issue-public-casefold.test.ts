import { describe, expect, it } from 'vitest';
import {
  caseFoldingTableUsable,
  caseInsensitiveLiteral,
  engineFoldCodePoint,
  escapeRegExp,
  foldCodePoint,
  foldCodePointWith,
} from './issue-public-casefold.js';
import { literalSearcher } from './issue-public-literal-search.js';

/**
 * 正規表現エンジンで出す独立の正解 (bdboard-0hj9)。鍵の出現を、先読みの捕獲 `(?=(鍵)(?!直後の文字))` で重なるものも含めてすべて集め、
 * 厳密に重なる出現を 1 つの範囲に併合する (接しているだけは別)。周期的でない鍵では、以前の `/…/giu` の matchAll と同じ結果になる。
 */
function regexSpans(text: string, key: string, root: boolean): { start: number; end: number }[] {
  const pattern = new RegExp(`(?=(${escapeRegExp(key)})${root ? '(?![\\p{L}\\p{N}_-])' : ''})`, 'giu');
  const spans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(pattern)) {
    const occurrence = { start: match.index, end: match.index + (match[1]?.length ?? 0) };
    const previous = spans[spans.length - 1];
    if (previous && occurrence.start < previous.end) previous.end = Math.max(previous.end, occurrence.end);
    else spans.push(occurrence);
  }
  return spans;
}

// 大文字小文字の同値類が特殊なもの: Kelvin (U+212A) と k、long s (U+017F) と s、ß と ẞ (U+1E9E)、トルコ語の İ ı、ギリシャ語の σ ς Σ・
// θ ϑ ϴ・ι と U+0345・U+1FBE、Ω と Ohm (U+2126)、Å と Angstrom (U+212B)、Cherokee (大文字へたたむ)、Deseret (サロゲートの対)、
// 濁点の合成済み・分解形、CJK、区切り、根の直後の文字の条件に関わる文字 ("_"・"-"・数字・結合文字 U+0345)。
const ALPHABET = [
  'a', 'A', 'k', 'K', 'K', 's', 'S', 'ſ', 'ß', 'ẞ', 'ss', 'İ', 'ı', 'i', 'I', 'σ', 'ς', 'Σ', 'θ', 'ϑ', 'ϴ', 'Θ',
  'ͅ', 'ι', 'Ι', 'ι', 'Ω', 'Ω', 'ω', 'Å', 'Å', 'å', 'Ꭰ', 'ꭰ', '\u{10400}', '\u{10428}', 'が', 'が',
  '漢', '/', '\\', '-', '_', '1', '%e3', '%E3', 'é', 'é', ' ', '.', 'x', 'X',
];

describe('case-insensitive literal search (bdboard-uudb)', () => {
  it('folds a code point to the representative of its regex class, which the edge check needs (bdboard-2ydj)', () => {
    // toLowerCase では別になる対: µ/μ・ς/σ・ϑ/θ・ſ/s・U+1FBE/ι と、サロゲートの対 (Deseret)。
    const pairs = [
      ['µ', 'μ'],
      ['ς', 'σ'],
      ['ϑ', 'θ'],
      ['ſ', 's'],
      ['ι', 'ι'],
      ['\u{10400}', '\u{10428}'],
    ] as const;
    for (const [left, right] of pairs) expect(foldCodePoint(left)).toBe(foldCodePoint(right));
    // 1 コードポイントの文字どうしは、`u` フラグの `i` と同じ関係になる (たたんだ結果が等しい ⇔ 正規表現が一致する)。
    const singles = ALPHABET.filter((candidate) => Array.from(candidate).length === 1);
    for (const left of singles) {
      for (const right of singles) {
        expect(foldCodePoint(left) === foldCodePoint(right), `${left} ${right}`).toBe(new RegExp(escapeRegExp(left), 'iu').test(right));
      }
    }
    // 大文字小文字で変わらない文字と孤立サロゲートは、そのまま。
    for (const value of ['7', '漢', '\uD800']) expect(foldCodePoint(value)).toBe(value);
  });

  it('goes through the engine when the table is unusable (the wiring of the fallback, not only engineFoldCodePoint)', () => {
    // toLowerCase では別になる対。表が null のときに toLowerCase などへ退避する配線にすると、ここが落ちる。
    const pairs = [
      ['µ', 'μ'],
      ['ς', 'σ'],
      ['ϑ', 'θ'],
      ['ſ', 's'],
      ['ι', 'ι'],
    ] as const;
    for (const [left, right] of pairs) {
      expect(foldCodePointWith(left, null)).toBe(foldCodePointWith(right, null));
      expect(foldCodePointWith(left, null)).toBe(foldCodePoint(left));
    }
  });

  it('gives the same representative from the engine alone as from the table (the path for an engine without a usable table)', () => {
    const cased = /[\p{Changes_When_Casefolded}\p{Changes_When_Casemapped}]/u;
    for (let codePoint = 0; codePoint <= 0x1ffff; codePoint += 1) {
      if (codePoint === 0xd800) codePoint = 0xe000;
      const character = String.fromCodePoint(codePoint);
      if (cased.test(character)) expect(engineFoldCodePoint(character), `U+${codePoint.toString(16)}`).toBe(foldCodePoint(character));
    }
    for (const character of [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', '漢', '字', '\uD800', '\uDC00']) {
      expect(engineFoldCodePoint(character)).toBe(foldCodePoint(character));
    }
  }, 30_000);

  it('builds the equivalence table from the regex engine on this runtime', () => {
    expect(caseFoldingTableUsable()).toBe(true);
  });

  it('returns the same spans as the old /…/giu literal for keys and texts made of tricky case classes', () => {
    let state = 0x51ed;
    const next = (): number => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state;
    };
    const pick = (): string => ALPHABET[next() % ALPHABET.length] ?? '';
    for (let iteration = 0; iteration < 3000; iteration += 1) {
      const key = Array.from({ length: 1 + (next() % 4) }, pick).join('');
      // 本文は、鍵そのものと、でたらめな文字を混ぜる (同じ類の別の文字に替えた形は、乱択の文字で偶然に出るものと、下の 1 文字ずつの
      // 網羅のテストで確かめる)。
      const variants = [...ALPHABET].filter((candidate) => new RegExp(escapeRegExp(candidate), 'iu').test(key));
      const pieces = Array.from({ length: 12 }, () => (next() % 3 === 0 && variants.length > 0 ? key : pick()));
      const text = pieces.join('') + (variants[next() % Math.max(1, variants.length)] ?? '');
      for (const root of [false, true]) {
        const actual = literalSearcher(text)(caseInsensitiveLiteral(key, root));
        expect({ key, text, root, spans: actual }).toEqual({ key, text, root, spans: regexSpans(text, key, root) });
      }
    }
  });

  it('matches every code point that the engine treats as equal, and only those, for each cased letter key', () => {
    // 表に入る文字 (大文字小文字で変わりうる文字) を全部並べた本文で、各文字を鍵にしたときの一致が正規表現と同じ。
    const cased = /[\p{Changes_When_Casefolded}\p{Changes_When_Casemapped}]/u;
    const letters: string[] = [];
    for (let codePoint = 0; codePoint <= 0x1ffff; codePoint += 1) {
      if (codePoint === 0xd800) codePoint = 0xe000;
      const character = String.fromCodePoint(codePoint);
      if (cased.test(character)) letters.push(character);
    }
    const text = letters.join(' ');
    for (const letter of letters) {
      expect(literalSearcher(text)(caseInsensitiveLiteral(letter, false))).toEqual(regexSpans(text, letter, false));
    }
  });

  it('keeps positions across the 8,192-unit decode chunks, including a surrogate pair split by a chunk edge', () => {
    // 3 × 8,192 + 1 単位。たたみで変わる文字 (代表は類の最小のコードポイントなので q は Q に) で埋め、たたんだ文字列を作り直す経路を通す。
    const units = Array.from({ length: 3 * 8192 + 1 }, () => 'q');
    const place = (at: number, value: string): void => {
      for (let offset = 0; offset < value.length; offset += 1) units[at + offset] = value.charAt(offset);
    };
    place(8191, '\u{10400}'); // 上位サロゲートが 8,191、下位が 8,192
    place(16380, 'BoUnDaRy'); // 16,383 / 16,384 をまたぐ
    place(24569, 'bOuNdArY'); // 24,575 / 24,576 (最後のチャンクは 1 単位) をまたぐ
    const text = units.join('');
    expect(text.length).toBe(3 * 8192 + 1);
    for (const key of ['boundary', 'qbOUNDARY', '\u{10428}', 'q\u{10428}q']) {
      for (const root of [false, true]) {
        const expected = regexSpans(text, key, root);
        // 根は直後が英字の位置では一致しないので、根の鍵は末尾の 1 件だけのことがある (0 件になるのは根のときだけ)。
        expect(expected.length > 0 || root).toBe(true);
        expect(literalSearcher(text)(caseInsensitiveLiteral(key, root))).toEqual(expected);
      }
    }
  });

  it('does not reuse the fold of a different text of the same length and the same head', () => {
    const head = 'p'.repeat(64);
    const first = `${head}xxBoundaryxx`;
    const second = `${head}xxxxxxxxxxxx`;
    const key = caseInsensitiveLiteral('boundary', false);
    for (const text of [first, second, first, second]) {
      expect(literalSearcher(text)(key)).toEqual(regexSpans(text, 'boundary', false));
    }
    expect(literalSearcher(first)(key)).toEqual([{ start: 66, end: 74 }]);
    expect(literalSearcher(second)(key)).toEqual([]);
  });

  it('does not search a text shorter than the key, and keeps the root follower rule at the end of the text', () => {
    const key = caseInsensitiveLiteral('/work/Example', true);
    expect(literalSearcher('/work/exampl')(key)).toEqual([]);
    expect(literalSearcher('/WORK/EXAMPLE')(key)).toEqual([{ start: 0, end: 13 }]);
    expect(literalSearcher('/work/example2 /work/example_ /work/example-x /work/example/x')(key)).toEqual([{ start: 46, end: 59 }]);
    // 直後の文字で外れたら、1 つ右から探し直す (重なる位置の一致を見落とさない)。
    const periodic = caseInsensitiveLiteral('abab', true);
    expect(literalSearcher('ababab.')(periodic)).toEqual(regexSpans('ababab.', 'abab', true));
    expect(literalSearcher('ababab.')(periodic)).toEqual([{ start: 2, end: 6 }]);
  });
});
