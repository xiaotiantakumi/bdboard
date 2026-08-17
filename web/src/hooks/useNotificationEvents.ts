import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { acquireSharedEventSource } from '../lib/sseConnection';
import { UI_STORAGE_KEYS, validateBoolean, validateString } from '../uiPersistedState';
import { usePersistedState } from './usePersistedState';

const MAX_EVENTS = 50;

/** Short window for coalescing burst browser notifications. */
export const NOTIFICATION_BATCH_WINDOW_MS = 2500;

/** At or above this count within the window, emit one summary notification. */
export const NOTIFICATION_BATCH_THRESHOLD = 3;

export interface NotificationEventItem {
  readonly id: string;
  readonly kind: 'ticket_ready' | 'decision_pending' | 'session_died' | 'ai_quota_threshold';
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
}

export interface UseNotificationEventsResult {
  readonly events: readonly NotificationEventItem[];
  readonly unreadCount: number;
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
      item.kind !== 'ai_quota_threshold') ||
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

function notificationCopy(item: NotificationEventItem): { title: string; body: string } {
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

export function useNotificationEvents(): UseNotificationEventsResult {
  const [events, setEvents] = usePersistedState<NotificationEventItem[]>(
    UI_STORAGE_KEYS.notificationEvents,
    [],
    validateNotificationEvents,
  );
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
      setEvents((prev) => [item, ...prev].slice(0, MAX_EVENTS));
      enqueueBrowserNotification(item, notificationsEnabledRef.current);
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
  }, [setEvents, enqueueBrowserNotification]);

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
    markAllRead,
    notificationsEnabled,
    notificationsSupported,
    permission,
    enableNotifications,
    disableNotifications,
    notificationDeliveryError,
  };
}
