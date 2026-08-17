import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UI_STORAGE_KEYS } from '../uiPersistedState';
import { useNotificationEvents } from './useNotificationEvents';

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
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

describe('useNotificationEvents', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    localStorage.clear();
    notificationCtor.mockReset();
    MockNotification.permission = 'default';
    MockNotification.requestPermission = vi.fn(async () => 'granted');
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('Notification', MockNotification);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it('does not call Notification when the tab is visible even if enabled and granted', () => {
    MockNotification.permission = 'granted';
    localStorage.setItem(UI_STORAGE_KEYS.notificationsEnabled, 'true');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

    const { es } = renderNotificationEvents();

    act(() => {
      es.dispatch('notification', ticketReadyPayload());
    });

    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it('calls Notification when hidden, enabled, and permission is granted', () => {
    MockNotification.permission = 'granted';
    localStorage.setItem(UI_STORAGE_KEYS.notificationsEnabled, 'true');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    const { es } = renderNotificationEvents();

    act(() => {
      es.dispatch('notification', ticketReadyPayload());
    });

    expect(notificationCtor).toHaveBeenCalledWith('チケットが着手可能になりました', {
      body: 'Example ticket (bdboard-abc)',
      tag: 'ticket_ready:bdboard-abc:2026-08-17T10:00:00.000Z',
    });
  });

  it('does not call Notification when notificationsEnabled is false', () => {
    MockNotification.permission = 'granted';
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    const { es } = renderNotificationEvents();

    act(() => {
      es.dispatch('notification', ticketReadyPayload());
    });

    expect(notificationCtor).not.toHaveBeenCalled();
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
});
