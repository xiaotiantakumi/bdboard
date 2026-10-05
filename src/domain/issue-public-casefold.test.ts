import { describe, expect, it } from 'vitest';
import { caseFoldingTableUsable, caseInsensitiveLiteral, escapeRegExp, literalSearcher } from './issue-public-casefold.js';

/** 以前の探し方 (鍵ごとの /…/giu。根は直後の文字の先読みつき)。新しい探し方はこれと同じ一致を返す。 */
function regexSpans(text: string, key: string, root: boolean): { start: number; end: number }[] {
  const pattern = new RegExp(`${escapeRegExp(key)}${root ? '(?![\\p{L}\\p{N}_-])' : ''}`, 'giu');
  return Array.from(text.matchAll(pattern), (match) => ({ start: match.index, end: match.index + match[0].length }));
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
      // 本文は、鍵の各文字を同じ類の別の文字に替えたものと、でたらめな文字を混ぜる。
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
