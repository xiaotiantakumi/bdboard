/**
 * Code-unit (UTF-16) lexicographic order — a locale-independent total order.
 *
 * NOT code-point order. JavaScript's `<` / `>` on strings compare UTF-16 code
 * units, so a surrogate pair (U+10000 and above, lead unit 0xD800–0xDBFF) sorts
 * *before* U+E000–U+FFFF even though its code point is larger. The two orders
 * agree everywhere else.
 *
 * This is deliberately the same order as `Array.prototype.sort()` with no
 * comparator. Some call sites sort with this function and others with the bare
 * default — notably `web/src/App.tsx` builds `availableLabels` with a plain
 * `.sort()` while `web/src/components/BoardFilterBar.tsx` re-sorts the union
 * with `compareStrings`. "Fixing" this to true code-point order would silently
 * desync those two orderings, so don't (bdboard-254q).
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
