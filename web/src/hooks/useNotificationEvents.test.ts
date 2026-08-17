import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSharedEventSourceForTests } from '../lib/sseConnection';
import { UI_STORAGE_KEYS } from '../uiPersistedState';
import {
  NOTIFICATION_BATCH_THRESHOLD,
  NOTIFICATION_BATCH_WINDOW_MS,
  useNotificationEvents,
} from './useNotificationEvents';

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, data: string) {
    const event = { data } as MessageEvent<string>;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  close = vi.fn();
}

const notificationCtor = vi.fn();

class MockNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted');

  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    notificationCtor(this.title, this.options);
  }
}

function renderNotificationEvents() {
  const view = renderHook(() => useNotificationEvents());
  const es = MockEventSource.instances.at(-1)!;
  return { ...view, es };
}

function ticketReadyPayload(overrides: Record<string, string> = {}) {
  return JSON.stringify({
    kind: 'ticket_ready',
    ticketId: 'bdboard-abc',
    title: 'Example ticket',
    occurredAt: '2026-08-17T10:00:00.000Z',
    ...overrides,
  });
}

function advanceBatchWindow() {
  act(() => {
    vi.advanceTimersByTime(NOTIFICATION_BATCH_WINDOW_MS);
  });
}

function withFakeBatchTimers(run: () => void) {
  vi.useFakeTimers();
  try {
    run();
  } finally {
    vi.useRealTimers();
  }
}

describe('useNotificationEvents', () => {
  let hasFocusMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    MockEventSource.instances = [];
    __resetSharedEventSourceForTests();
    localStorage.clear();
    notificationCtor.mockReset();
    MockNotification.permission = 'default';
    MockNotification.requestPermission = vi.fn(async () => 'granted');
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('Notification', MockNotification);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    hasFocusMock = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    __resetSharedEventSourceForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('adds an event when a notification SSE message is received', () => {
    const { result, es } = renderNotificationEvents();

    act(() => {
      es.dispatch('notification', ticketReadyPayload());
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toMatchObject({
      kind: 'ticket_ready',
      ticketId: 'bdboard-abc',
      title: 'Example ticket',
      id: 'ticket_ready:bdboard-abc:2026-08-17T10:00:00.000Z',
    });
    expect(result.current.unreadCount).toBe(1);
  });

  it('does not call Notification when the tab is visible and focused even if enabled and granted', () => {
    withFakeBatchTimers(() => {
      MockNotification.permission = 'granted';
      localStorage.setItem(UI_STORAGE_KEYS.notificationsEnabled, 'true');
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      hasFocusMock.mockReturnValue(true);

      const { es } = renderNotificationEvents();

      act(() => {
        es.dispatch('notification', ticketReadyPayload());
      });
      advanceBatchWindow();

      expect(notificationCtor).not.toHaveBeenCalled();
    });
  });

  it('calls Notification when hidden, enabled, and permission is granted', () => {
    withFakeBatchTimers(() => {
      MockNotification.permission = 'granted';
      localStorage.setItem(UI_STORAGE_KEYS.notificationsEnabled, 'true');
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

      const { es } = renderNotificationEvents();

      act(() => {
        es.dispatch('notification', ticketReadyPayload());
      });
      advanceBatchWindow();

      expect(notificationCtor).toHaveBeenCalledWith('チケットが着手可能になりました', {
        body: 'Example ticket (bdboard-abc)',
        tag: 'ticket_ready:bdboard-abc:2026-08-17T10:00:00.000Z',
      });
    });
  });

  it('does not call Notification when notificationsEnabled is false', () => {
    withFakeBatchTimers(() => {
      MockNotification.permission = 'granted';
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

      const { es } = renderNotificationEvents();

      act(() => {
        es.dispatch('notification', ticketReadyPayload());
      });
      advanceBatchWindow();

      expect(notificationCtor).not.toHaveBeenCalled();
    });
  });

  it('calls requestPermission only when permission is default', async () => {
    MockNotification.permission = 'default';
    const { result } = renderNotificationEvents();

    await act(async () => {
      await result.current.enableNotifications();
    });

    expect(MockNotification.requestPermission).toHaveBeenCalledOnce();
    expect(result.current.notificationsEnabled).toBe(true);
  });

  it('does not call requestPermission when permission is already granted', async () => {
    MockNotification.permission = 'granted';
    const { result } = renderNotificationEvents();

    await act(async () => {
      await result.current.enableNotifications();
    });

    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
    expect(result.current.notificationsEnabled).toBe(true);
  });

  it('does not call requestPermission when permission is denied', async () => {
    MockNotification.permission = 'denied';
    const { result } = renderNotificationEvents();

    await act(async () => {
      await result.current.enableNotifications();
    });

    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
    expect(result.current.notificationsEnabled).toBe(false);
  });

  it('sets unreadCount to 0 after markAllRead', async () => {
    const { result, es } = renderNotificationEvents();

    act(() => {
      es.dispatch('notification', ticketReadyPayload());
    });
    expect(result.current.unreadCount).toBe(1);

    act(() => {
      result.current.markAllRead();
    });

    await waitFor(() => {
      expect(result.current.unreadCount).toBe(0);
    });
  });

  it('closes EventSource on unmount', () => {
    const { es, unmount } = renderNotificationEvents();
    unmount();
    expect(es.close).toHaveBeenCalled();
  });

  it('calls Notification when the tab is visible but the window lacks focus (M6)', () => {
    withFakeBatchTimers(() => {
      MockNotification.permission = 'granted';
      localStorage.setItem(UI_STORAGE_KEYS.notificationsEnabled, 'true');
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      hasFocusMock.mockReturnValue(false);

      const { es } = renderNotificationEvents();

      act(() => {
        es.dispatch('notification', ticketReadyPayload());
      });
      advanceBatchWindow();

      expect(notificationCtor).toHaveBeenCalledWith('チケットが着手可能になりました', {
        body: 'Example ticket (bdboard-abc)',
        tag: 'ticket_ready:bdboard-abc:2026-08-17T10:00:00.000Z',
      });
    });
  });

  it('does not call Notification when visible and focused (M6 regression)', () => {
    withFakeBatchTimers(() => {
      MockNotification.permission = 'granted';
      localStorage.setItem(UI_STORAGE_KEYS.notificationsEnabled, 'true');
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      hasFocusMock.mockReturnValue(true);

      const { es } = renderNotificationEvents();

      act(() => {
        es.dispatch('notification', ticketReadyPayload());
      });
      advanceBatchWindow();

      expect(notificationCtor).not.toHaveBeenCalled();
    });
  });

  it('emits one summary notification when the batch threshold is reached within the window (M4)', () => {
    withFakeBatchTimers(() => {
      MockNotification.permission = 'granted';
      localStorage.setItem(UI_STORAGE_KEYS.notificationsEnabled, 'true');
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

      const { es } = renderNotificationEvents();

      act(() => {
        for (let i = 0; i < NOTIFICATION_BATCH_THRESHOLD; i++) {
          es.dispatch(
            'notification',
            ticketReadyPayload({
              ticketId: `bdboard-${i}`,
              title: `Ticket ${i}`,
              occurredAt: `2026-08-17T10:00:0${i}.000Z`,
            }),
          );
        }
      });
      advanceBatchWindow();

      expect(notificationCtor).toHaveBeenCalledOnce();
      expect(notificationCtor).toHaveBeenCalledWith(
        `${NOTIFICATION_BATCH_THRESHOLD}件の更新があります`,
        {
          body: `着手可能 ${NOTIFICATION_BATCH_THRESHOLD}件`,
          tag: 'batch:2026-08-17T10:00:00.000Z',
        },
      );
    });
  });

  it('emits individual notifications when below the batch threshold (M4 regression)', () => {
    withFakeBatchTimers(() => {
      MockNotification.permission = 'granted';
      localStorage.setItem(UI_STORAGE_KEYS.notificationsEnabled, 'true');
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

      const { es } = renderNotificationEvents();
      const belowThreshold = NOTIFICATION_BATCH_THRESHOLD - 1;

      act(() => {
        for (let i = 0; i < belowThreshold; i++) {
          es.dispatch(
            'notification',
            ticketReadyPayload({
              ticketId: `bdboard-${i}`,
              title: `Ticket ${i}`,
              occurredAt: `2026-08-17T10:00:0${i}.000Z`,
            }),
          );
        }
      });
      advanceBatchWindow();

      expect(notificationCtor).toHaveBeenCalledTimes(belowThreshold);
      expect(notificationCtor).toHaveBeenNthCalledWith(1, 'チケットが着手可能になりました', {
        body: 'Ticket 0 (bdboard-0)',
        tag: 'ticket_ready:bdboard-0:2026-08-17T10:00:00.000Z',
      });
      expect(notificationCtor).toHaveBeenNthCalledWith(2, 'チケットが着手可能になりました', {
        body: 'Ticket 1 (bdboard-1)',
        tag: 'ticket_ready:bdboard-1:2026-08-17T10:00:01.000Z',
      });
    });
  });

  it('records notificationDeliveryError and warns when Notification constructor throws (M5)', () => {
    withFakeBatchTimers(() => {
      MockNotification.permission = 'granted';
      localStorage.setItem(UI_STORAGE_KEYS.notificationsEnabled, 'true');
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      notificationCtor.mockImplementation(() => {
        throw new Error('Illegal constructor');
      });

      const { result, es } = renderNotificationEvents();

      act(() => {
        es.dispatch('notification', ticketReadyPayload());
      });
      advanceBatchWindow();

      expect(warnSpy).toHaveBeenCalled();
      expect(result.current.notificationDeliveryError).toBe('Illegal constructor');
    });
  });

  it('clears the pending batch timer on unmount without flushing notifications', () => {
    withFakeBatchTimers(() => {
      MockNotification.permission = 'granted';
      localStorage.setItem(UI_STORAGE_KEYS.notificationsEnabled, 'true');
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

      const { es, unmount } = renderNotificationEvents();

      act(() => {
        es.dispatch('notification', ticketReadyPayload());
      });
      unmount();
      advanceBatchWindow();

      expect(notificationCtor).not.toHaveBeenCalled();
    });
  });
});
