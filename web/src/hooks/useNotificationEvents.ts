import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardCardDto, TicketDetailDto } from '../api';
import { acquireSharedEventSource } from '../lib/sseConnection';
import {
  buildTicketWatchSnapshot,
  diffTicketWatchSnapshots,
  type TicketWatchEvent,
  type TicketWatchSnapshot,
} from '../ticketWatch';
import { UI_STORAGE_KEYS, validateBoolean, validateString } from '../uiPersistedState';
import { usePersistedState } from './usePersistedState';

const MAX_EVENTS = 50;

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

function mergeUniqueNotificationEvents(
  prev: readonly NotificationEventItem[],
  incoming: readonly NotificationEventItem[],
): { merged: NotificationEventItem[]; added: NotificationEventItem[] } {
  if (incoming.length === 0) {
    return { merged: prev as NotificationEventItem[], added: [] };
  }
  const seenIds = new Set(prev.map((event) => event.id));
  const added: NotificationEventItem[] = [];
  for (const item of incoming) {
    if (seenIds.has(item.id)) {
      continue;
    }
    seenIds.add(item.id);
    added.push(item);
  }
  if (added.length === 0) {
    return { merged: prev as NotificationEventItem[], added };
  }
  return { merged: [...added, ...prev].slice(0, MAX_EVENTS), added };
}

/** Short window for coalescing burst browser notifications. */
export const NOTIFICATION_BATCH_WINDOW_MS = 2500;

/** At or above this count within the window, emit one summary notification. */
export const NOTIFICATION_BATCH_THRESHOLD = 3;

export interface NotificationEventItem {
  readonly id: string;
  readonly kind:
    | 'ticket_ready'
    | 'decision_pending'
    | 'session_died'
    | 'ai_quota_threshold'
    | 'watched_lane_changed'
    | 'watched_comment_changed'
    | 'watched_session_changed';
  readonly occurredAt: string;
  readonly ticketId?: string;
  readonly title?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly name?: string;
  readonly providerId?: string;
  readonly providerLabel?: string;
  readonly metricLabel?: string;
  readonly percentRemaining?: number;
  readonly thresholdPercent?: number;
  readonly resetAt?: string;
  readonly fromLane?: string;
  readonly toLane?: string;
  readonly previousCommentCount?: number;
  readonly commentCount?: number;
  readonly addedSessionIds?: readonly string[];
  readonly removedSessionIds?: readonly string[];
}

export interface UseNotificationEventsOptions {
  readonly watchedTicketIds?: ReadonlySet<string>;
  readonly boardCardsById?: ReadonlyMap<string, BoardCardDto>;
  readonly watchedTicketDetails?: ReadonlyMap<string, TicketDetailDto>;
}

export interface UseNotificationEventsResult {
  readonly events: readonly NotificationEventItem[];
  readonly unreadCount: number;
  readonly lastReadAt: string | null;
  readonly markAllRead: () => void;
  readonly notificationsEnabled: boolean;
  readonly notificationsSupported: boolean;
  readonly permission: NotificationPermission | 'unsupported';
  readonly enableNotifications: () => Promise<void>;
  readonly disableNotifications: () => void;
  /** Set when `new Notification()` fails (e.g. Android Chrome Illegal constructor). */
  readonly notificationDeliveryError: string | null;
}

type TicketNotificationKind = 'ticket_ready' | 'decision_pending';

type NotificationPayload =
  | {
      kind: TicketNotificationKind;
      ticketId: string;
      title?: string;
      projectId?: string;
      occurredAt: string;
    }
  | {
      kind: 'session_died';
      sessionId: string;
      cwd: string;
      name?: string;
      lastActivityAt: string;
      occurredAt: string;
    }
  | {
      kind: 'ai_quota_threshold';
      providerId: string;
      providerLabel: string;
      metricLabel: string;
      percentRemaining: number;
      thresholdPercent: number;
      resetAt?: string;
      occurredAt: string;
    };

function isTicketNotificationKind(kind: unknown): kind is TicketNotificationKind {
  return kind === 'ticket_ready' || kind === 'decision_pending';
}

function isNotificationPayload(value: unknown): value is NotificationPayload {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.occurredAt !== 'string') {
    return false;
  }
  if (isTicketNotificationKind(payload.kind)) {
    return typeof payload.ticketId === 'string';
  }
  if (payload.kind === 'session_died') {
    return typeof payload.sessionId === 'string' && typeof payload.cwd === 'string';
  }
  if (payload.kind === 'ai_quota_threshold') {
    return (
      typeof payload.providerId === 'string' &&
      typeof payload.providerLabel === 'string' &&
      typeof payload.metricLabel === 'string' &&
      typeof payload.percentRemaining === 'number' &&
      typeof payload.thresholdPercent === 'number'
    );
  }
  return false;
}

function validateNotificationEventItem(value: unknown): NotificationEventItem | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== 'string' ||
    (item.kind !== 'ticket_ready' &&
      item.kind !== 'decision_pending' &&
      item.kind !== 'session_died' &&
      item.kind !== 'ai_quota_threshold' &&
      item.kind !== 'watched_lane_changed' &&
      item.kind !== 'watched_comment_changed' &&
      item.kind !== 'watched_session_changed') ||
    typeof item.occurredAt !== 'string'
  ) {
    return null;
  }
  if (item.ticketId !== undefined && typeof item.ticketId !== 'string') {
    return null;
  }
  if (item.title !== undefined && typeof item.title !== 'string') {
    return null;
  }
  if (item.projectId !== undefined && typeof item.projectId !== 'string') {
    return null;
  }
  if (item.sessionId !== undefined && typeof item.sessionId !== 'string') {
    return null;
  }
  if (item.cwd !== undefined && typeof item.cwd !== 'string') {
    return null;
  }
  if (item.name !== undefined && typeof item.name !== 'string') {
    return null;
  }
  if (item.providerId !== undefined && typeof item.providerId !== 'string') {
    return null;
  }
  if (item.providerLabel !== undefined && typeof item.providerLabel !== 'string') {
    return null;
  }
  if (item.metricLabel !== undefined && typeof item.metricLabel !== 'string') {
    return null;
  }
  if (item.percentRemaining !== undefined && typeof item.percentRemaining !== 'number') {
    return null;
  }
  if (item.thresholdPercent !== undefined && typeof item.thresholdPercent !== 'number') {
    return null;
  }
  if (item.resetAt !== undefined && typeof item.resetAt !== 'string') {
    return null;
  }
  if (item.fromLane !== undefined && typeof item.fromLane !== 'string') {
    return null;
  }
  if (item.toLane !== undefined && typeof item.toLane !== 'string') {
    return null;
  }
  if (item.previousCommentCount !== undefined && typeof item.previousCommentCount !== 'number') {
    return null;
  }
  if (item.commentCount !== undefined && typeof item.commentCount !== 'number') {
    return null;
  }
  if (
    item.addedSessionIds !== undefined &&
    (!Array.isArray(item.addedSessionIds) ||
      !item.addedSessionIds.every((entry) => typeof entry === 'string'))
  ) {
    return null;
  }
  if (
    item.removedSessionIds !== undefined &&
    (!Array.isArray(item.removedSessionIds) ||
      !item.removedSessionIds.every((entry) => typeof entry === 'string'))
  ) {
    return null;
  }
  return value as NotificationEventItem;
}

function validateNotificationEvents(value: unknown): NotificationEventItem[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items: NotificationEventItem[] = [];
  for (const entry of value) {
    const validated = validateNotificationEventItem(entry);
    if (validated === null) {
      return null;
    }
    items.push(validated);
  }
  return items;
}

function validateLastReadAt(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return validateString(value);
}

function buildNotificationEventItem(payload: NotificationPayload): NotificationEventItem {
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

function buildWatchedNotificationEventItem(
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

function notificationCopy(item: NotificationEventItem): { title: string; body: string } {
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

function buildSummaryNotification(items: NotificationEventItem[]): { title: string; body: string } {
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

function shouldSuppressBrowserNotification(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function passesBrowserNotificationGate(notificationsEnabled: boolean): boolean {
  if (typeof Notification === 'undefined') {
    return false;
  }
  if (Notification.permission !== 'granted') {
    return false;
  }
  if (!notificationsEnabled) {
    return false;
  }
  if (shouldSuppressBrowserNotification()) {
    return false;
  }
  return true;
}

export function useNotificationEvents(
  options?: UseNotificationEventsOptions,
): UseNotificationEventsResult {
  const [events, setEvents] = usePersistedState<NotificationEventItem[]>(
    UI_STORAGE_KEYS.notificationEvents,
    [],
    validateNotificationEvents,
  );
  const eventsRef = useRef<readonly NotificationEventItem[]>(events);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  const [lastReadAt, setLastReadAt] = usePersistedState<string | null>(
    UI_STORAGE_KEYS.notificationLastReadAt,
    null,
    validateLastReadAt,
  );
  const [notificationsEnabled, setNotificationsEnabled] = usePersistedState(
    UI_STORAGE_KEYS.notificationsEnabled,
    false,
    validateBoolean,
  );
  const [notificationDeliveryError, setNotificationDeliveryError] = useState<string | null>(null);

  const notificationsEnabledRef = useRef(notificationsEnabled);
  const batchBufferRef = useRef<NotificationEventItem[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchedSnapshotsRef = useRef<Map<string, TicketWatchSnapshot>>(new Map());

  const watchedTicketIds = options?.watchedTicketIds;
  const boardCardsById = options?.boardCardsById;
  const watchedTicketDetails = options?.watchedTicketDetails;

  useEffect(() => {
    notificationsEnabledRef.current = notificationsEnabled;
  }, [notificationsEnabled]);

  const deliverBrowserNotification = useCallback((title: string, body: string, tag: string) => {
    try {
      new Notification(title, { body, tag });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Browser notification constructor failed';
      console.warn('Browser notification delivery failed:', error);
      setNotificationDeliveryError(message);
    }
  }, []);

  const flushNotificationBatch = useCallback(() => {
    batchTimerRef.current = null;
    const items = batchBufferRef.current;
    batchBufferRef.current = [];

    if (items.length === 0) {
      return;
    }
    if (!passesBrowserNotificationGate(notificationsEnabledRef.current)) {
      return;
    }

    if (items.length >= NOTIFICATION_BATCH_THRESHOLD) {
      const summary = buildSummaryNotification(items);
      deliverBrowserNotification(summary.title, summary.body, `batch:${items[0]!.occurredAt}`);
      return;
    }

    for (const item of items) {
      const { title, body } = notificationCopy(item);
      deliverBrowserNotification(title, body, item.id);
    }
  }, [deliverBrowserNotification]);

  const enqueueBrowserNotification = useCallback(
    (item: NotificationEventItem, notificationsEnabled: boolean) => {
      if (!passesBrowserNotificationGate(notificationsEnabled)) {
        return;
      }

      batchBufferRef.current.push(item);
      if (batchTimerRef.current !== null) {
        return;
      }

      batchTimerRef.current = setTimeout(() => {
        flushNotificationBatch();
      }, NOTIFICATION_BATCH_WINDOW_MS);
    },
    [flushNotificationBatch],
  );

  const appendNotificationItems = useCallback(
    (items: readonly NotificationEventItem[]) => {
      if (items.length === 0) {
        return;
      }
      const { merged, added } = mergeUniqueNotificationEvents(eventsRef.current, items);
      if (added.length === 0) {
        return;
      }
      eventsRef.current = merged;
      setEvents(merged);
      for (const item of added) {
        enqueueBrowserNotification(item, notificationsEnabledRef.current);
      }
    },
    [setEvents, enqueueBrowserNotification],
  );

  useEffect(() => {
    if (
      watchedTicketIds === undefined ||
      watchedTicketIds.size === 0 ||
      boardCardsById === undefined
    ) {
      watchedSnapshotsRef.current = new Map();
      return;
    }

    const details = watchedTicketDetails ?? new Map<string, TicketDetailDto>();
    const occurredAt = new Date().toISOString();
    const newItems: NotificationEventItem[] = [];
    const nextSnapshots = new Map<string, TicketWatchSnapshot>();

    for (const ticketId of watchedTicketIds) {
      const current = buildTicketWatchSnapshot(ticketId, boardCardsById, details);
      if (current === null) {
        const previous = watchedSnapshotsRef.current.get(ticketId);
        if (previous !== undefined) {
          nextSnapshots.set(ticketId, previous);
        }
        continue;
      }

      const previous = watchedSnapshotsRef.current.get(ticketId);
      if (previous === undefined) {
        nextSnapshots.set(ticketId, current);
        continue;
      }

      const transitions = diffTicketWatchSnapshots(previous, current);
      for (const transition of transitions) {
        newItems.push(buildWatchedNotificationEventItem(transition, current, occurredAt));
      }
      nextSnapshots.set(ticketId, current);
    }

    watchedSnapshotsRef.current = nextSnapshots;
    appendNotificationItems(newItems);
  }, [watchedTicketIds, boardCardsById, watchedTicketDetails, appendNotificationItems]);

  useEffect(() => {
    const conn = acquireSharedEventSource();

    const onNotification = (event: MessageEvent<string>) => {
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isNotificationPayload(payload)) {
        return;
      }

      const item = buildNotificationEventItem(payload);
      appendNotificationItems([item]);
    };

    conn.addEventListener('notification', onNotification as EventListener);

    return () => {
      conn.removeEventListener('notification', onNotification as EventListener);
      conn.release();
      if (batchTimerRef.current !== null) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      batchBufferRef.current = [];
    };
  }, [appendNotificationItems]);

  const unreadCount = useMemo(() => {
    const boundary = lastReadAt ?? '';
    return events.filter((event) => event.occurredAt > boundary).length;
  }, [events, lastReadAt]);

  const markAllRead = useCallback(() => {
    setLastReadAt(new Date().toISOString());
  }, [setLastReadAt]);

  const enableNotifications = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      return;
    }
    if (Notification.permission === 'granted') {
      setNotificationsEnabled(true);
      return;
    }
    if (Notification.permission === 'denied') {
      return;
    }
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      setNotificationsEnabled(true);
    }
  }, [setNotificationsEnabled]);

  const disableNotifications = useCallback(() => {
    setNotificationsEnabled(false);
  }, [setNotificationsEnabled]);

  const notificationsSupported = typeof Notification !== 'undefined';
  const permission = notificationsSupported ? Notification.permission : 'unsupported';

  return {
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
  };
}
