import type { SyncHealthDto } from '../api';

export interface SyncHealthBadgeProps {
  health: SyncHealthDto | undefined;
}

export function SyncHealthBadge({ health }: SyncHealthBadgeProps) {
  if (health === undefined || health.status === 'ok') {
    return null;
  }

  const className =
    health.status === 'attention'
      ? 'sync-health-badge sync-health-badge-attention'
      : 'sync-health-badge sync-health-badge-unknown';

  const label = health.status === 'attention' ? '同期要確認' : '同期不明';
  const title = health.reasons.map((reason) => reason.message).join(' / ');

  return (
    <span className={className} title={title || undefined}>
      ⚠ {label}
    </span>
  );
}
