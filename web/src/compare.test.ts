import { describe, expect, it } from 'vitest';

import { compareStrings } from './compare';

// U+10000 (LINEAR B SYLLABLE B008 A) is '𐀀' in UTF-16. Its lead
// surrogate 0xD800 is below 0xE000, so code-unit order puts it first, while
// true code-point order (0x10000 > 0xE000) would put it last. This pair is the
// only kind of input where the two orders disagree, so it is the whole point of
// this file.
const ASTRAL = '\u{10000}';
const PRIVATE_USE = '\uE000';

describe('compareStrings', () => {
  it('orders by UTF-16 code unit, not by code point', () => {
    expect(compareStrings(ASTRAL, PRIVATE_USE)).toBeLessThan(0);
    // Sanity check that the fixtures really are the discriminating pair:
    // by code point the expectation above would be reversed.
    expect(ASTRAL.codePointAt(0)).toBeGreaterThan(PRIVATE_USE.codePointAt(0) as number);
  });

  it('matches Array.prototype.sort() with no comparator', () => {
    // Load-bearing: web/src/App.tsx sorts availableLabels with a bare .sort()
    // and web/src/components/BoardFilterBar.tsx re-sorts the union with
    // compareStrings. If these two orders ever diverge, the label list silently
    // reorders between the two code paths (bdboard-254q).
    const input = [PRIVATE_USE, 'a', 'Z', ASTRAL, 'b', 'A', 'アイウ', '0', '', 'z'];
    expect([...input].sort(compareStrings)).toEqual([...input].sort());
  });

  it('is a total order: antisymmetric, reflexive on equals, and transitive', () => {
    expect(compareStrings('a', 'a')).toBe(0);
    expect(compareStrings('a', 'b')).toBe(-1);
    expect(compareStrings('b', 'a')).toBe(1);
    // 'Z' (U+005A) before 'a' (U+0061) — localeCompare would give the opposite.
    expect(compareStrings('Z', 'a')).toBe(-1);
    expect('Z'.localeCompare('a')).toBeGreaterThan(0);
  });

  it('treats a prefix as smaller than the string that extends it', () => {
    expect(compareStrings('bd', 'bdboard')).toBe(-1);
    expect(compareStrings('', 'a')).toBe(-1);
    expect(compareStrings('', '')).toBe(0);
  });
});
