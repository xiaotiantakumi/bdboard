import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { acquireSharedEventSource } from '../lib/sseConnection';
import { writeNotificationLastEventId } from '../lib/notificationLastEventId';
import { UI_STORAGE_KEYS } from '../uiPersistedState';
import { usePersistedState } from './usePersistedState';
import { NOTIFICATION_BATCH_THRESHOLD, NOTIFICATION_BATCH_WINDOW_MS } from './notification-events/constants';
import { mergeUniqueNotificationEvents } from './notification-events/eventMerging';
import { buildNotificationEventItem } from './notification-events/eventBuilders';
import { isNotificationPayload, validateLastReadAt, validateNotificationEvents } from './notification-events/payloadValidation';
import { notificationCopy, buildSummaryNotification } from './notification-events/notificationCopy';
import { passesBrowserNotificationGate } from './notification-events/browserNotificationGate';
import { useNotificationPermission } from './notification-events/useNotificationPermission';
import { useWatchedTicketNotifications } from './notification-events/useWatchedTicketNotifications';
import type {
  NotificationEventItem,
  UseNotificationEventsOptions,
  UseNotificationEventsResult,
} from './notification-events/types';

export type { NotificationEventItem, UseNotificationEventsOptions, UseNotificationEventsResult };
export { NOTIFICATION_BATCH_THRESHOLD, NOTIFICATION_BATCH_WINDOW_MS } from './notification-events/constants';

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
  const {
    notificationsEnabled,
    notificationsEnabledRef,
    notificationsSupported,
    permission,
    enableNotifications,
    disableNotifications,
  } = useNotificationPermission();
  const [notificationDeliveryError, setNotificationDeliveryError] = useState<string | null>(null);

  const batchBufferRef = useRef<NotificationEventItem[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    // notificationsEnabledRef is the useRef object returned by useNotificationPermission();
    // its identity is stable for the component's lifetime the same way a locally-declared
    // useRef would be, so it is intentionally omitted here (deps arrays are kept identical to
    // the pre-split hook body, per bdboard-sso1.30 PR-B's effect-order-invariance requirement).
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    (
      items: readonly NotificationEventItem[],
      { notifyBrowser = true }: { readonly notifyBrowser?: boolean } = {},
    ) => {
      if (items.length === 0) {
        return;
      }
      const { merged, added } = mergeUniqueNotificationEvents(eventsRef.current, items);
      if (added.length === 0) {
        return;
      }
      eventsRef.current = merged;
      setEvents(merged);
      if (!notifyBrowser) {
        return;
      }
      for (const item of added) {
        enqueueBrowserNotification(item, notificationsEnabledRef.current);
      }
    },
    // Same stable-ref rationale as flushNotificationBatch's deps array above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setEvents, enqueueBrowserNotification],
  );

  useWatchedTicketNotifications(options, appendNotificationItems);

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

      // 再接続時にサーバーが取り戻した分 (replayed) はイベントセンターにだけ戻し、
      // デスクトップ通知は鳴らさない。まとめて鳴ると古い通知が今起きたように見えるため
      // (bdboard-3tw.161)。id は payload 由来のままなので、既に見た分やクロスタブで
      // 同期済みの分は mergeUniqueNotificationEvents で落ちる (bdboard-7io7)。
      const item = buildNotificationEventItem(payload);
      appendNotificationItems([item], { notifyBrowser: payload.replayed !== true });
      // 受け取れた (検証を通って一覧に反映した) 通知の id だけを控える。検証に落ちた通知の
      // id まで控えると、画面を更新して読めるようになっても次の接続で再送されなくなる。
      if (typeof event.lastEventId === 'string' && event.lastEventId !== '') {
        writeNotificationLastEventId(event.lastEventId);
      }
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
