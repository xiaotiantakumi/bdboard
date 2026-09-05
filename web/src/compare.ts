// Canonical implementation: src/domain/compare.ts
// Mirrored here because web cannot import src/ directly.

/**
 * Code-unit (UTF-16) lexicographic order — a locale-independent total order.
 *
 * NOT code-point order. JavaScript's `<` / `>` on strings compare UTF-16 code
 * units, which sorts an astral character (U+10000 and above) *as if it were its
 * lead surrogate* 0xD800–0xDBFF. So an astral character sorts before
 * U+E000–U+FFFF, before any unpaired trail surrogate U+DC00–U+DFFF, and
 * interleaved among unpaired lead surrogates — even though its code point is
 * larger than all of them. The two orders agree on everything below U+D801.
 *
 * This is deliberately the same order as `Array.prototype.sort()` with no
 * comparator: the default comparator comes from the same `<` semantics, so the
 * two are interchangeable by construction, not by coincidence. Some call sites
 * still sort with the bare default, so "fixing" this to true code-point order
 * would silently desync them (bdboard-254q).
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
