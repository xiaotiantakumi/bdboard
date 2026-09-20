// bdboard-sso1.5: TicketDetailPanel.tsx から純粋な表示整形ヘルパーを移動した
// だけのファイル。挙動は一切変えていない。
import { formatAbsoluteTime } from '../../formatAbsoluteTime';
import type { SessionDto } from '../../api';

export function formatDateTime(value: string | undefined): string {
  if (value === undefined) return '—';
  return formatAbsoluteTime(value);
}

export function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

export function sessionLinkBadgeLabel(source: 'metadata' | 'transcript'): string {
  return source === 'metadata' ? '手動' : '自動推定';
}

export function sessionLinkBadgeClass(source: 'metadata' | 'transcript'): string {
  return source === 'metadata' ? 'badge-link-manual' : 'badge-link-inferred';
}

export function formatSessionPickerLabel(session: SessionDto): string {
  return session.name !== undefined
    ? `${session.name} (${session.cwd})`
    : `${session.sessionId} (${session.cwd})`;
}
