import { getBoardTimeZone } from './boardTimeZone';

/**
 * ISO 8601 文字列や epoch ミリ秒をロケール依存の絶対時刻表記へ変換する。
 *
 * 表示タイムゾーンはボード設定 (BDBOARD_TIMEZONE) に従う。パース不能な値は
 * 例外を投げず、元の値を文字列化してそのまま返す
 * (DiscoveredSessionsPanel の formatActivityTime と同じフォールバック)。
 */
export function formatAbsoluteTime(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString(undefined, { timeZone: getBoardTimeZone() });
}
