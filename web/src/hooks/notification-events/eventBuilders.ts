import type { TicketWatchEvent, TicketWatchSnapshot } from '../../ticketWatch';
import type { NotificationEventItem, NotificationPayload } from './types';

/**
 * ウォッチ差分検知は各タブが独立に `new Date().toISOString()` で occurredAt を生成するため、
 * 同一の意味的な遷移でもタブ間で厳密には異なるタイムスタンプになりうる。id生成時だけ粗い
 * バケットに丸めることで、数秒程度のタブ間ジッターを吸収し、クロスタブの重複排除(id一致)が
 * 機能するようにする。バケット幅を超えて離れた時刻の遷移(同じfrom/toの組み合わせが数分後に
 * 再度起きた場合など)は別idとして扱われ、正しく別イベントとして残る。
 */
const WATCHED_EVENT_ID_TIME_BUCKET_MS = 5000;

function watchedEventIdTimeBucket(occurredAt: string): string {
  const time = Date.parse(occurredAt);
  if (Number.isNaN(time)) {
    return occurredAt;
  }
  return String(Math.floor(time / WATCHED_EVENT_ID_TIME_BUCKET_MS));
}

export function buildNotificationEventItem(payload: NotificationPayload): NotificationEventItem {
  if (payload.kind === 'session_died') {
    return {
      id: `${payload.kind}:${payload.sessionId}:${payload.occurredAt}`,
      kind: payload.kind,
      occurredAt: payload.occurredAt,
      sessionId: payload.sessionId,
      cwd: payload.cwd,
      name: payload.name,
    };
  }
  if (payload.kind === 'ai_quota_threshold') {
    return {
      id: `${payload.kind}:${payload.providerId}:${payload.metricLabel}:${payload.occurredAt}`,
      kind: payload.kind,
      occurredAt: payload.occurredAt,
      providerId: payload.providerId,
      providerLabel: payload.providerLabel,
      metricLabel: payload.metricLabel,
      percentRemaining: payload.percentRemaining,
      thresholdPercent: payload.thresholdPercent,
      resetAt: payload.resetAt,
    };
  }
  return {
    id: `${payload.kind}:${payload.ticketId}:${payload.occurredAt}`,
    kind: payload.kind,
    occurredAt: payload.occurredAt,
    ticketId: payload.ticketId,
    title: payload.title,
    projectId: payload.projectId,
  };
}

export function buildWatchedNotificationEventItem(
  event: TicketWatchEvent,
  snapshot: TicketWatchSnapshot,
  occurredAt: string,
): NotificationEventItem {
  const base = {
    occurredAt,
    ticketId: event.ticketId,
    ...(snapshot.title !== undefined ? { title: snapshot.title } : {}),
    ...(snapshot.projectId !== undefined ? { projectId: snapshot.projectId } : {}),
  };

  const idTimeBucket = watchedEventIdTimeBucket(occurredAt);

  switch (event.kind) {
    case 'lane_changed':
      return {
        id: `watched_lane_changed:${event.ticketId}:${event.fromLane}:${event.toLane}:${idTimeBucket}`,
        kind: 'watched_lane_changed',
        fromLane: event.fromLane,
        toLane: event.toLane,
        ...base,
      };
    case 'comment_count_changed':
      return {
        id: `watched_comment_changed:${event.ticketId}:${event.fromCount}:${event.toCount}:${idTimeBucket}`,
        kind: 'watched_comment_changed',
        previousCommentCount: event.fromCount,
        commentCount: event.toCount,
        ...base,
      };
    case 'session_links_changed':
      return {
        id: `watched_session_changed:${event.ticketId}:${idTimeBucket}`,
        kind: 'watched_session_changed',
        addedSessionIds: event.addedSessionIds,
        removedSessionIds: event.removedSessionIds,
        ...base,
      };
  }
}
