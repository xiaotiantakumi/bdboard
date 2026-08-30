import { formatAbsoluteTime } from '../formatAbsoluteTime';
import type { NotificationEventItem, UseNotificationEventsResult } from '../hooks/useNotificationEvents';

function kindLabel(kind: NotificationEventItem['kind']): string {
  switch (kind) {
    case 'ticket_ready':
      return '着手可能';
    case 'decision_pending':
      return '決定待ち';
    case 'session_died':
      return 'セッション終了';
    case 'ai_quota_threshold':
      return 'クォータ低下';
    case 'watched_lane_changed':
      return 'ウォッチ: レーン遷移';
    case 'watched_comment_changed':
      return 'ウォッチ: コメント';
    case 'watched_session_changed':
      return 'ウォッチ: セッション';
  }
}

function eventPrimaryText(item: NotificationEventItem): string {
  if (item.kind === 'watched_lane_changed') {
    const ticketLabel =
      item.title !== undefined && item.title.length > 0
        ? `${item.title} (${item.ticketId})`
        : item.ticketId ?? '—';
    return `${ticketLabel}: ${item.fromLane ?? ''} → ${item.toLane ?? ''}`;
  }
  if (item.kind === 'watched_comment_changed') {
    const ticketLabel =
      item.title !== undefined && item.title.length > 0
        ? `${item.title} (${item.ticketId})`
        : item.ticketId ?? '—';
    return `${ticketLabel}: ${item.previousCommentCount ?? 0} → ${item.commentCount ?? 0}`;
  }
  if (item.kind === 'watched_session_changed') {
    const ticketLabel =
      item.title !== undefined && item.title.length > 0
        ? `${item.title} (${item.ticketId})`
        : item.ticketId ?? '—';
    const added = item.addedSessionIds?.length ?? 0;
    const removed = item.removedSessionIds?.length ?? 0;
    return `${ticketLabel}: +${added} -${removed}`;
  }
  if (item.providerId !== undefined) {
    return `${item.providerLabel ?? item.providerId} ${item.metricLabel ?? ''} 残り${item.percentRemaining}%(閾値${item.thresholdPercent}%)`.trim();
  }
  if (item.ticketId !== undefined) {
    if (item.title !== undefined && item.title.length > 0) {
      return `${item.title} (${item.ticketId})`;
    }
    return item.ticketId;
  }
  if (item.name !== undefined && item.name.length > 0) {
    return item.name;
  }
  return item.sessionId ?? item.cwd ?? '—';
}

function formatOccurredAt(occurredAt: string): string {
  return formatAbsoluteTime(occurredAt);
}

export function EventCenterPanel({
  events,
  unreadCount,
  lastReadAt,
  markAllRead,
  notificationsEnabled,
  notificationsSupported,
  permission,
  enableNotifications,
  disableNotifications,
  notificationDeliveryError,
}: UseNotificationEventsResult) {
  return (
    <section className="event-center-panel" aria-label="イベント">
      <div className="event-center-panel-header">
        <h2 className="event-center-panel-title">イベント</h2>
        <p className="event-center-panel-subtitle">
          ボード上の通知イベントを確認し、デスクトップ通知の設定を行います。
        </p>
      </div>

      <section
        className="event-center-panel-section"
        aria-labelledby="event-center-notifications-title"
      >
        <h3 id="event-center-notifications-title">デスクトップ通知</h3>
        {!notificationsSupported ? (
          <p className="event-center-panel-empty">
            このブラウザはデスクトップ通知に対応していません
          </p>
        ) : permission === 'denied' ? (
          <p className="event-center-panel-warning" role="alert">
            ブラウザの設定で通知がブロックされています。通知を受け取るには、ブラウザのサイト設定から
            bdboard の通知を許可してください。
          </p>
        ) : notificationsEnabled ? (
          <div className="event-center-panel-notif-status">
            <span className="event-center-panel-badge">デスクトップ通知: 有効</span>
            <button type="button" onClick={disableNotifications}>
              無効にする
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => void enableNotifications()}>
            デスクトップ通知を有効にする
          </button>
        )}
        {notificationDeliveryError !== null && (
          <p className="event-center-panel-warning" role="alert">
            {notificationDeliveryError}
          </p>
        )}
      </section>

      <section
        className="event-center-panel-section"
        aria-labelledby="event-center-events-title"
      >
        <div className="event-center-panel-section-header">
          <h3 id="event-center-events-title">イベント一覧</h3>
          {unreadCount > 0 && (
            <button type="button" onClick={markAllRead}>
              すべて既読にする
            </button>
          )}
        </div>
        {events.length === 0 ? (
          <p className="event-center-panel-empty">まだイベントはありません</p>
        ) : (
          <ul className="event-center-panel-list">
            {events.map((item) => {
              const isUnread = item.occurredAt > (lastReadAt ?? '');
              return (
                <li
                  key={item.id}
                  className={`event-center-panel-item${isUnread ? ' event-center-panel-item-unread' : ''}`}
                >
                  <div className="event-center-panel-item-header">
                    <span className="event-center-panel-kind">{kindLabel(item.kind)}</span>
                    {isUnread && (
                      <span className="event-center-panel-unread-dot" aria-label="未読" />
                    )}
                  </div>
                  <p className="event-center-panel-item-text">{eventPrimaryText(item)}</p>
                  <time className="event-center-panel-item-time" dateTime={item.occurredAt}>
                    {formatOccurredAt(item.occurredAt)}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
