/**
 * 昇順ソート済みの配列に対する分位点 (線形補間、numpy 既定と同じ R-7)。
 * 中央値が偶数件でも「真ん中2つの平均」になるので、median と p90 で計算方式が
 * ぶれない。戻り値はミリ秒として整数に丸める。
 */
export function percentileMs(sortedValues: readonly number[], p: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const clamped = Math.min(1, Math.max(0, p));
  const rank = (sortedValues.length - 1) * clamped;
  const lowIndex = Math.floor(rank);
  const highIndex = Math.ceil(rank);
  const low = sortedValues[lowIndex];
  const high = sortedValues[highIndex];
  if (low === undefined || high === undefined) {
    return null;
  }
  return Math.round(low + (high - low) * (rank - lowIndex));
}
