import { readNotificationLastEventId } from './notificationLastEventId';

const EVENT_SOURCE_OPEN = 1;

/**
 * The server pings every 15s. If nothing at all has arrived for three ping
 * intervals when the page comes back to the foreground, the socket is almost
 * certainly frozen: mobile PWAs suspend a backgrounded EventSource without
 * firing onerror, and it can stay OPEN forever. Replacing it is the only way
 * to get the server to replay notifications missed meanwhile (bdboard-3tw.161).
 */
export const SSE_STALE_AFTER_MS = 45_000;

/** Event types the server sends; any of them proves the socket is alive. */
const ACTIVITY_EVENT_TYPES = ['hello', 'ping', 'notification', 'board.changed', 'session.changed'];

function eventsUrl(): string {
  // Absolute URL built from origin rather than relative '/api/events': a
  // relative URL resolves against the document URL, and if that still carries
  // QR credentials WebKit rejects the EventSource outright. `origin` never
  // includes userinfo. See stripUrlCredentials.ts.
  const base = `${window.location.origin}/api/events`;
  // A fresh EventSource has no Last-Event-ID, so tell the server which
  // notification we saw last; it replays only newer ones (bdboard-3tw.161).
  // The browser's own auto-reconnect sends the header, which the server prefers.
  const lastEventId = readNotificationLastEventId();
  return lastEventId === null
    ? base
    : `${base}?lastEventId=${encodeURIComponent(lastEventId)}`;
}

type OpenListener = () => void;
type ErrorListener = () => void;

export interface SharedEventSourceHandle {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  addOpenListener(listener: OpenListener): void;
  removeOpenListener(listener: OpenListener): void;
  addErrorListener(listener: ErrorListener): void;
  removeErrorListener(listener: ErrorListener): void;
  release(): void;
}

let refCount = 0;
let eventSource: EventSource | null = null;
let lastActivityAtMs = 0;
let visibilityListenerAttached = false;
const openListeners = new Set<OpenListener>();
const errorListeners = new Set<ErrorListener>();
const namedListeners = new Map<string, Set<EventListener>>();

function dispatchOpen(): void {
  for (const listener of openListeners) {
    listener();
  }
}

function dispatchError(): void {
  for (const listener of errorListeners) {
    listener();
  }
}

function attachNamedListeners(es: EventSource): void {
  for (const [type, listeners] of namedListeners) {
    for (const listener of listeners) {
      es.addEventListener(type, listener);
    }
  }
}

function touchActivity(): void {
  lastActivityAtMs = Date.now();
}

function attachEventSourceHandlers(es: EventSource): void {
  touchActivity();
  es.onopen = () => {
    touchActivity();
    dispatchOpen();
  };
  es.onerror = () => dispatchError();
  for (const type of ACTIVITY_EVENT_TYPES) {
    es.addEventListener(type, touchActivity);
  }
  attachNamedListeners(es);
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible') {
    return;
  }
  // CONNECTING means the browser is already retrying; CLOSED is recovered by
  // the explicit reconnect path in useBoardStream.
  if (refCount === 0 || eventSource === null || eventSource.readyState !== EVENT_SOURCE_OPEN) {
    return;
  }
  if (Date.now() - lastActivityAtMs < SSE_STALE_AFTER_MS) {
    return;
  }
  reconnectSharedEventSource();
}

function attachVisibilityListener(): void {
  if (visibilityListenerAttached || typeof document === 'undefined') {
    return;
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  visibilityListenerAttached = true;
}

function detachVisibilityListener(): void {
  if (!visibilityListenerAttached) {
    return;
  }
  document.removeEventListener('visibilitychange', onVisibilityChange);
  visibilityListenerAttached = false;
}

function ensureEventSource(): EventSource {
  if (eventSource === null) {
    eventSource = new EventSource(eventsUrl());
    attachEventSourceHandlers(eventSource);
  }
  attachVisibilityListener();
  return eventSource;
}

function resetIfIdle(): void {
  if (refCount === 0 && eventSource !== null) {
    eventSource.close();
    eventSource = null;
    openListeners.clear();
    errorListeners.clear();
    namedListeners.clear();
    detachVisibilityListener();
  }
}

/**
 * Replace the shared EventSource while keeping registered listeners.
 * EventSource in readyState CLOSED (2) after a non-200 response never
 * auto-reconnects; this is the only way to recover without a full reload.
 */
export function reconnectSharedEventSource(): void {
  if (eventSource !== null) {
    eventSource.close();
    eventSource = null;
  }
  if (refCount > 0) {
    eventSource = new EventSource(eventsUrl());
    attachEventSourceHandlers(eventSource);
  }
}

export function acquireSharedEventSource(): SharedEventSourceHandle {
  refCount += 1;
  ensureEventSource();

  return {
    addEventListener(type, listener) {
      if (!namedListeners.has(type)) {
        namedListeners.set(type, new Set());
      }
      namedListeners.get(type)!.add(listener);
      eventSource?.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      namedListeners.get(type)?.delete(listener);
      if (namedListeners.get(type)?.size === 0) {
        namedListeners.delete(type);
      }
      eventSource?.removeEventListener(type, listener);
    },
    addOpenListener(listener) {
      openListeners.add(listener);
      if (eventSource?.readyState === EVENT_SOURCE_OPEN) {
        listener();
      }
    },
    removeOpenListener(listener) {
      openListeners.delete(listener);
    },
    addErrorListener(listener) {
      errorListeners.add(listener);
    },
    removeErrorListener(listener) {
      errorListeners.delete(listener);
    },
    release() {
      refCount = Math.max(0, refCount - 1);
      resetIfIdle();
    },
  };
}

/** Test-only reset when RTL cleanup order leaves module state behind. */
export function __resetSharedEventSourceForTests(): void {
  refCount = 0;
  detachVisibilityListener();
  lastActivityAtMs = 0;
  if (eventSource !== null) {
    eventSource.close();
    eventSource = null;
  }
  openListeners.clear();
  errorListeners.clear();
  namedListeners.clear();
}
