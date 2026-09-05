import { describe, expect, it } from 'vitest';
import { compareStrings } from './compare';

// U+10000 (LINEAR B SYLLABLE B008 A)。UTF-16 では 𐀀 の2コードユニットで
// 表され、比較上はリードサロゲート 0xD800 が効く。
const ASTRAL = '\u{10000}';
// 私用領域の先頭。コードポイントは U+10000 より小さいが、コードユニット順では
// 0xE000 > 0xD800 なので astral より後ろに来る。
const PRIVATE_USE = '\uE000';
// 孤立トレイルサロゲート。JSON の \uDC00 エスケープやコードユニット単位の
// 切り詰め (src/domain/text.ts の truncate) から実際に生まれうる。
// 2つの順序が食い違うのは U+E000 以上だけではなく U+D801 以上すべてで、
// 孤立サロゲートもそこに含まれる。
const LONE_TRAIL_SURROGATE = '\uDC00';

describe('compareStrings', () => {
  it('orders by UTF-16 code unit, not by code point', () => {
    expect(compareStrings(ASTRAL, PRIVATE_USE)).toBe(-1);
    expect(compareStrings(ASTRAL, LONE_TRAIL_SURROGATE)).toBe(-1);
    // フィクスチャが本当に「食い違う組」であることの健全性チェック。
    // 効いているのはリードサロゲートが 0xE000 未満であるという機構のほうなので、
    // 結論 (コードポイントの大小) と機構の両方を押さえる。
    expect(ASTRAL.charCodeAt(0)).toBeLessThan(PRIVATE_USE.charCodeAt(0));
    expect(ASTRAL.codePointAt(0)).toBeGreaterThan(PRIVATE_USE.codePointAt(0) as number);
  });

  it('matches Array.prototype.sort() with no comparator', () => {
    // 効いているのは ASTRAL / PRIVATE_USE / LONE_TRAIL_SURROGATE の3つで、他の
    // 要素は BMP 非サロゲートなのでどちらの順序でも同じ位置に来る。それでも
    // 空振りにはならない — 識別力のある要素が1つでも入っていれば、コンパレータを
    // コードポイント順へ差し替えた瞬間に配列全体が不一致になる。
    //
    // これは load-bearing: web/src/App.tsx と web/src/components/BoardFilterBar.tsx
    // が同じラベル集合をそれぞれ .sort(compareStrings) で並べており、
    // compareStrings が素の .sort() とずれた瞬間に両者が desync する。
    const input = [
      PRIVATE_USE, 'a', 'Z', ASTRAL, 'b', 'A', 'アイウ', '0', '', 'z',
      LONE_TRAIL_SURROGATE,
    ];
    expect([...input].sort(compareStrings)).toEqual([...input].sort());
  });

  it('is a total order: antisymmetric, reflexive on equals, and transitive', () => {
    expect(compareStrings('a', 'a')).toBe(0);
    expect(compareStrings('a', 'b')).toBe(-1);
    expect(compareStrings('b', 'a')).toBe(1);
    // 推移律 (テスト名が主張している以上、実際に測る)。
    expect(compareStrings('a', 'b')).toBe(-1);
    expect(compareStrings('b', 'c')).toBe(-1);
    expect(compareStrings('a', 'c')).toBe(-1);
  });

  it('differs from localeCompare, which is locale-dependent', () => {
    // 'Z' (U+005A) は 'a' (U+0061) より前。localeCompare は逆を返す。
    expect(compareStrings('Z', 'a')).toBe(-1);
    // これは compareStrings ではなく実行環境 (ICU) を測るアサーション。対比の
    // ためだけに置いている。--without-intl ビルドの Node では成り立たない。
    expect('Z'.localeCompare('a')).toBeGreaterThan(0);
  });

  it('treats a prefix as smaller than the string that extends it', () => {
    expect(compareStrings('bd', 'bdboard')).toBe(-1);
    expect(compareStrings('', 'a')).toBe(-1);
    expect(compareStrings('', '')).toBe(0);
  });
});
