import type { NotificationEventItem } from './types';

export function notificationCopy(item: NotificationEventItem): { title: string; body: string } {
  const ticketLabel = `${item.title ?? item.ticketId ?? 'チケット'} (${item.ticketId ?? ''})`.trim();
  switch (item.kind) {
    case 'ticket_ready':
      return {
        title: 'チケットが着手可能になりました',
        body: `${item.title ?? item.ticketId} (${item.ticketId})`,
      };
    case 'decision_pending':
      return {
        title: '決定待ちが発生しました',
        body: `${item.title ?? item.ticketId} (${item.ticketId})`,
      };
    case 'session_died':
      return {
        title: 'セッションが終了しました',
        body: `${item.name ?? item.cwd}`,
      };
    case 'ai_quota_threshold':
      return {
        title: 'AIクォータ残量が閾値を下回りました',
        body: `${item.providerLabel ?? item.providerId} ${item.metricLabel ?? ''} 残り${item.percentRemaining}%(閾値${item.thresholdPercent}%)`.trim(),
      };
    case 'watched_lane_changed':
      return {
        title: 'ウォッチ中のチケットがレーン遷移しました',
        body: `${ticketLabel}: ${item.fromLane ?? ''} → ${item.toLane ?? ''}`,
      };
    case 'watched_comment_changed':
      return {
        title: 'ウォッチ中のチケットのコメントが更新されました',
        body: `${ticketLabel}: ${item.previousCommentCount ?? 0} → ${item.commentCount ?? 0}`,
      };
    case 'watched_session_changed':
      const added = item.addedSessionIds?.length ?? 0;
      const removed = item.removedSessionIds?.length ?? 0;
      return {
        title: 'ウォッチ中のチケットのセッション紐付けが変わりました',
        body: `${ticketLabel}: +${added} -${removed}`,
      };
  }
}

function kindSummaryLabel(kind: NotificationEventItem['kind'], count: number): string {
  switch (kind) {
    case 'ticket_ready':
      return `着手可能 ${count}件`;
    case 'decision_pending':
      return `決定待ち ${count}件`;
    case 'session_died':
      return `セッション終了 ${count}件`;
    case 'ai_quota_threshold':
      return `クォータ低下 ${count}件`;
    case 'watched_lane_changed':
      return `ウォッチレーン遷移 ${count}件`;
    case 'watched_comment_changed':
      return `ウォッチコメント ${count}件`;
    case 'watched_session_changed':
      return `ウォッチセッション ${count}件`;
  }
}

export function buildSummaryNotification(items: NotificationEventItem[]): {
  title: string;
  body: string;
} {
  const counts = new Map<NotificationEventItem['kind'], number>();
  for (const item of items) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  const parts = Array.from(counts.entries()).map(([kind, count]) => kindSummaryLabel(kind, count));
  return {
    title: `${items.length}件の更新があります`,
    body: parts.join('、'),
  };
}
