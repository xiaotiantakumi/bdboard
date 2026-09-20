import type { BoardCardDto } from '../../api';
import { localDateKey } from '../activityFeedFormatting';

export function priorityBadgeClass(priority: number): string {
  if (priority === 0) return 'badge-p0';
  if (priority === 1) return 'badge-p1';
  if (priority === 2) return 'badge-p2';
  if (priority === 3) return 'badge-p3';
  return 'badge-p4';
}

export function formatDeferDate(deferUntil: string): string {
  // ISO 文字列を slice(0, 10) すると UTC の日付になる。defer は UI 側が
  // ローカル日付で送り、bd が「その日のローカル深夜」の UTC 瞬間として持つので
  // (例: Asia/Tokyo なら …T15:00:00Z)、素朴に切ると常に1日前を表示していた (bdboard-ol9)。
  // 日付境界は board の設定タイムゾーン（デフォルトはブラウザ TZ、BDBOARD_TIMEZONE で
  // 上書き可）で求める — CI は UTC で走るので host TZ に頼ると環境で結果が変わる
  // (bdboard-3tw.75)。手書きのオフセット算術は tzdata の歴史的例外で食い違うため使わない。
  return localDateKey(new Date(deferUntil));
}

export function formatDeferCountdown(
  deferDays: number,
  deferUrgency: BoardCardDto['deferUrgency'],
): string {
  if (deferUrgency === 'overdue' || deferDays < 0) {
    return '期限超過';
  }
  if (deferUrgency === 'today' || deferDays === 0) {
    return '今日';
  }
  return `あと${deferDays}日`;
}

export function deferCountdownClass(deferUrgency: BoardCardDto['deferUrgency']): string {
  switch (deferUrgency) {
    case 'overdue':
      return 'badge badge-defer-countdown badge-defer-overdue';
    case 'today':
    case 'soon':
      return 'badge badge-defer-countdown badge-defer-soon';
    default:
      return 'badge badge-defer-countdown';
  }
}
