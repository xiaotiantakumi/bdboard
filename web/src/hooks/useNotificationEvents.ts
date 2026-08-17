import { useCallback, useEffect, useMemo, useRef } from 'react';
import { UI_STORAGE_KEYS, validateBoolean, validateString } from '../uiPersistedState';
import { usePersistedState } from './usePersistedState';

const MAX_EVENTS = 50;

export interface NotificationEventItem {
  readonly id: string;
  readonly kind: 'ticket_ready' | 'decision_pending' | 'session_died';
  readonly occurredAt: string;
  readonly ticketId?: string;
  readonly title?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly name?: string;
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
      item.kind !== 'session_died') ||
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
  }
}

function maybeShowBrowserNotification(
  item: NotificationEventItem,
  notificationsEnabled: boolean,
): void {
  if (typeof Notification === 'undefined') {
    return;
  }
  if (Notification.permission !== 'granted') {
    return;
  }
  if (!notificationsEnabled) {
    return;
  }
  if (document.visibilityState === 'visible') {
    return;
  }
  const { title, body } = notificationCopy(item);
  new Notification(title, { body, tag: item.id });
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

  const notificationsEnabledRef = useRef(notificationsEnabled);
  useEffect(() => {
    notificationsEnabledRef.current = notificationsEnabled;
  }, [notificationsEnabled]);

  useEffect(() => {
    const es = new EventSource(`${window.location.origin}/api/events`);

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
      maybeShowBrowserNotification(item, notificationsEnabledRef.current);
    };

    es.addEventListener('notification', onNotification as EventListener);

    return () => {
      es.removeEventListener('notification', onNotification as EventListener);
      es.close();
    };
  }, [setEvents]);

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
  };
}
