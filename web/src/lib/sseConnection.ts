const EVENT_SOURCE_OPEN = 1;

function eventsUrl(): string {
  // Absolute URL built from origin rather than relative '/api/events': a
  // relative URL resolves against the document URL, and if that still carries
  // QR credentials WebKit rejects the EventSource outright. `origin` never
  // includes userinfo. See stripUrlCredentials.ts.
  return `${window.location.origin}/api/events`;
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

function attachEventSourceHandlers(es: EventSource): void {
  es.onopen = () => dispatchOpen();
  es.onerror = () => dispatchError();
  attachNamedListeners(es);
}

function ensureEventSource(): EventSource {
  if (eventSource === null) {
    eventSource = new EventSource(eventsUrl());
    attachEventSourceHandlers(eventSource);
  }
  return eventSource;
}

function resetIfIdle(): void {
  if (refCount === 0 && eventSource !== null) {
    eventSource.close();
    eventSource = null;
    openListeners.clear();
    errorListeners.clear();
    namedListeners.clear();
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
  if (eventSource !== null) {
    eventSource.close();
    eventSource = null;
  }
  openListeners.clear();
  errorListeners.clear();
  namedListeners.clear();
}
