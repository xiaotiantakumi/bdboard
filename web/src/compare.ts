// Canonical implementation: src/domain/compare.ts
// Mirrored here because web cannot import src/ directly.

/** Code-point lexicographic order (locale-independent total order). */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
