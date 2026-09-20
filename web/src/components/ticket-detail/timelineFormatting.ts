// bdboard-sso1.5: TicketDetailPanel.tsx からタイムライン表示の純粋ヘルパーを
// 移動しただけのファイル。挙動は一切変えていない。
import type { ActivityEventDto } from '../../api';

export function timelineKindBadgeClass(
  kind: ActivityEventDto['kind'],
): string {
  return `activity-kind-badge activity-kind-${kind}`;
}

export function formatTimelineChangeDetail(
  kind: ActivityEventDto['kind'],
  from: string | undefined,
  to: string | undefined,
): string | undefined {
  if (
    (kind === 'status_changed' || kind === 'priority_changed') &&
    from !== undefined &&
    to !== undefined
  ) {
    return `${from} → ${to}`;
  }
  return undefined;
}
