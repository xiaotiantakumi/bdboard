// bdboard-sso1.5: TicketDetailPanel.tsx から純粋な表示整形ヘルパーを移動した
// だけのファイル。挙動は一切変えていない。
import { formatAbsoluteTime } from '../../formatAbsoluteTime';

export function formatDateTime(value: string | undefined): string {
  if (value === undefined) return '—';
  return formatAbsoluteTime(value);
}

export function formatTokenCount(value: number): string {
  return value.toLocaleString();
}
