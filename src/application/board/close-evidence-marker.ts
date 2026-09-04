/**
 * コメント本文に close 証拠 (PR:/検証: の記載) があるかを判定する。
 *
 * getPrBadges (PR バッジ) と getCloseEvidence (closed_without_evidence 判定) の
 * 両方から使われる。1回の bd comments 走査から両方の値を導出できるように
 * (bdboard-pkr6.16)、判定ロジックだけをここに独立させ、get-pr-badges.ts と
 * get-close-evidence.ts のどちらにも依存方向を作らない。
 */
export function hasCloseEvidenceMarker(text: string): boolean {
  if (text.includes('PR:') || text.includes('PR：')) {
    return true;
  }
  if (text.includes('検証:') || text.includes('検証：')) {
    return true;
  }
  return false;
}
